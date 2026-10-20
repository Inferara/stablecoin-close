//! `ReportAnchor`: records the SHA-256 of a finished period-close report, so
//! anyone holding the report file can later check that it was not changed.
//!
//! One anchor per `(company_id_hash, period)`. Anchoring is write-once: a second
//! call for the same company and period is refused, whatever its hash. A
//! corrected report is a new fact for a reader to weigh, not a silent
//! overwrite: it is disclosed in the next period's report, and the anchor of
//! the original stays where it was.
//!
//! The first anchor for a company binds that company to its signer (the
//! company's owner). From then on only the owner can anchor further periods,
//! so a company id hash that has become public (it is an event topic and it
//! is in every verifier link) cannot be used by someone else to take the
//! company's future periods first. The owner can hand the company over to
//! another address with `transfer_owner`.
//!
//! The company is identified only by a hash the company chooses; no name or
//! registration number is stored on chain.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    BytesN, Env, String,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// This company and period are already anchored.
    AlreadyAnchored = 1,
    /// The period is not a `YYYY-MM` month.
    InvalidPeriod = 2,
    /// The company is bound to another signer.
    NotOwner = 3,
    /// The company has never been anchored, so it has no owner yet.
    UnknownCompany = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Anchor {
    pub report_sha256: BytesN<32>,
    pub signer: Address,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Anchor(BytesN<32>, String),
    Owner(BytesN<32>),
}

/// Published when a report is anchored.
///
/// topics: `[Symbol("anchored"), BytesN<32>(company_id_hash), String(period)]`
/// data:   map `{ report_sha256: BytesN<32>, signer: Address }`
#[contractevent(topics = ["anchored"], data_format = "map")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Anchored {
    #[topic]
    pub company_id_hash: BytesN<32>,
    #[topic]
    pub period: String,
    pub report_sha256: BytesN<32>,
    pub signer: Address,
}

/// Published when a company is handed to another owner.
///
/// topics: `[Symbol("owner_changed"), BytesN<32>(company_id_hash)]`
/// data:   map `{ new_owner: Address, old_owner: Address }`
#[contractevent(topics = ["owner_changed"], data_format = "map")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnerChanged {
    #[topic]
    pub company_id_hash: BytesN<32>,
    pub old_owner: Address,
    pub new_owner: Address,
}

// Roughly 30 days at 5-second ledgers: the contract instance (and its code)
// and every entry read or written are kept alive at least this long, and
// topped up to the network maximum, on every call.
const TTL_THRESHOLD: u32 = 518_400;

#[contract]
pub struct ReportAnchor;

#[contractimpl]
impl ReportAnchor {
    /// Anchors `report_sha256` for one company and month, signed by `signer`
    /// (the reviewer who signed off the close). The first anchor of a company
    /// makes `signer` its owner; later ones must come from the owner.
    pub fn anchor(
        env: Env,
        signer: Address,
        company_id_hash: BytesN<32>,
        period: String,
        report_sha256: BytesN<32>,
    ) {
        signer.require_auth();
        bump_instance(&env);
        if !is_month(&period) {
            panic_with_error!(&env, Error::InvalidPeriod);
        }
        let owner_key = DataKey::Owner(company_id_hash.clone());
        match env.storage().persistent().get::<_, Address>(&owner_key) {
            Some(owner) if owner != signer => panic_with_error!(&env, Error::NotOwner),
            Some(_) => {}
            None => env.storage().persistent().set(&owner_key, &signer),
        }
        extend(&env, &owner_key);

        let key = DataKey::Anchor(company_id_hash.clone(), period.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::AlreadyAnchored);
        }
        let anchor = Anchor {
            report_sha256: report_sha256.clone(),
            signer: signer.clone(),
            ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&key, &anchor);
        extend(&env, &key);
        Anchored {
            company_id_hash,
            period,
            report_sha256,
            signer,
        }
        .publish(&env);
    }

    /// The anchor for a company and month, if there is one.
    pub fn get(env: Env, company_id_hash: BytesN<32>, period: String) -> Option<Anchor> {
        bump_instance(&env);
        let key = DataKey::Anchor(company_id_hash, period);
        let anchor: Option<Anchor> = env.storage().persistent().get(&key);
        if anchor.is_some() {
            extend(&env, &key);
        }
        anchor
    }

    /// The address allowed to anchor this company's periods, if it has any
    /// anchor yet.
    pub fn owner(env: Env, company_id_hash: BytesN<32>) -> Option<Address> {
        bump_instance(&env);
        let key = DataKey::Owner(company_id_hash);
        let owner: Option<Address> = env.storage().persistent().get(&key);
        if owner.is_some() {
            extend(&env, &key);
        }
        owner
    }

    /// Hands a company to `new_owner` (for example a new reviewer). Signed by
    /// the current owner. Anchors already made keep their original signer.
    pub fn transfer_owner(env: Env, company_id_hash: BytesN<32>, new_owner: Address) {
        bump_instance(&env);
        let key = DataKey::Owner(company_id_hash.clone());
        let old_owner: Address = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::UnknownCompany));
        old_owner.require_auth();
        env.storage().persistent().set(&key, &new_owner);
        extend(&env, &key);
        OwnerChanged {
            company_id_hash,
            old_owner,
            new_owner,
        }
        .publish(&env);
    }
}

/// `YYYY-MM` with a month from 01 to 12.
fn is_month(period: &String) -> bool {
    if period.len() != 7 {
        return false;
    }
    let mut b = [0u8; 7];
    period.copy_into_slice(&mut b);
    let digits = |r: &[u8]| r.iter().all(u8::is_ascii_digit);
    if !digits(&b[0..4]) || b[4] != b'-' || !digits(&b[5..7]) {
        return false;
    }
    let month = (b[5] - b'0') * 10 + (b[6] - b'0');
    (1..=12).contains(&month)
}

fn bump_instance(env: &Env) {
    let max = env.storage().max_ttl();
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD.min(max), max);
}

fn extend(env: &Env, key: &DataKey) {
    let max = env.storage().max_ttl();
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD.min(max), max);
}

#[cfg(test)]
mod test;
