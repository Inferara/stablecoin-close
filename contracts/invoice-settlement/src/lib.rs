//! `InvoiceSettlement`: a merchant registers an invoice by its hash, and a payer
//! settles it with one call that moves the registered amount of the registered
//! asset straight to the merchant.
//!
//! The payer never chooses the asset or the amount: `pay_invoice` takes only the
//! invoice hash and transfers exactly what the merchant registered. A wrong
//! asset or a wrong amount is therefore impossible by construction, rather than
//! something the contract has to detect.
//!
//! Nothing personal is stored on chain. The invoice is identified by
//! `invoice_hash`, the SHA-256 of a canonical reference string that starts with
//! a secret salt only the merchant knows (see the README), and by the invoice
//! number the merchant chose to publish. The salt is what stops anyone else
//! from computing an invoice's hash and registering it first, with themselves
//! as the merchant.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, BytesN, Env, String,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// No invoice is registered under this hash.
    UnknownInvoice = 1,
    /// An invoice is already registered under this hash.
    AlreadyRegistered = 2,
    /// The invoice has already been paid.
    AlreadyPaid = 3,
    /// The amount must be greater than zero.
    InvalidAmount = 4,
    /// The invoice number must not be empty.
    EmptyInvoiceNumber = 5,
}

/// A settled invoice: who paid it, and when.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payment {
    pub payer: Address,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Status {
    Open,
    Paid(Payment),
}

/// Everything the merchant registered, plus the current status.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Invoice {
    pub merchant: Address,
    pub invoice_number: String,
    /// The Stellar Asset Contract (SAC) of the asset to be paid in.
    pub asset: Address,
    /// In the asset's smallest unit (stroops for a 7-decimal Stellar asset).
    pub amount: i128,
    /// Due date as a Unix timestamp (seconds). Informational: a late payment
    /// is still accepted, because refusing it would only leave the debt open.
    pub due: u64,
    pub status: Status,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Invoice(BytesN<32>),
}

/// Published when an invoice is paid.
///
/// topics: `[Symbol("invoice_paid"), String(invoice_number)]`
/// data:   map `{ amount: i128, asset: Address, invoice_hash: BytesN<32>, payer: Address }`
#[contractevent(topics = ["invoice_paid"], data_format = "map")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvoicePaid {
    #[topic]
    pub invoice_number: String,
    pub payer: Address,
    pub asset: Address,
    pub amount: i128,
    pub invoice_hash: BytesN<32>,
}

/// Published when an invoice is registered.
///
/// topics: `[Symbol("invoice_registered"), String(invoice_number)]`
#[contractevent(topics = ["invoice_registered"], data_format = "map")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvoiceRegistered {
    #[topic]
    pub invoice_number: String,
    pub merchant: Address,
    pub asset: Address,
    pub amount: i128,
    pub due: u64,
    pub invoice_hash: BytesN<32>,
}

// Roughly 30 days at 5-second ledgers: the contract instance (and its code)
// and every entry read or written are kept alive at least this long, and
// topped up to the network maximum, on every call.
const TTL_THRESHOLD: u32 = 518_400;

#[contract]
pub struct InvoiceSettlement;

#[contractimpl]
impl InvoiceSettlement {
    /// Registers an invoice. Only the merchant can register an invoice payable
    /// to themselves.
    pub fn register_invoice(
        env: Env,
        merchant: Address,
        invoice_number: String,
        invoice_hash: BytesN<32>,
        asset: Address,
        amount: i128,
        due: u64,
    ) {
        merchant.require_auth();
        bump_instance(&env);
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if invoice_number.is_empty() {
            panic_with_error!(&env, Error::EmptyInvoiceNumber);
        }
        let key = DataKey::Invoice(invoice_hash.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::AlreadyRegistered);
        }
        let invoice = Invoice {
            merchant: merchant.clone(),
            invoice_number: invoice_number.clone(),
            asset: asset.clone(),
            amount,
            due,
            status: Status::Open,
        };
        save(&env, &key, &invoice);
        InvoiceRegistered {
            invoice_number,
            merchant,
            asset,
            amount,
            due,
            invoice_hash,
        }
        .publish(&env);
    }

    /// Pays an open invoice: transfers the registered amount of the registered
    /// asset from `payer` to the merchant and marks the invoice paid.
    pub fn pay_invoice(env: Env, payer: Address, invoice_hash: BytesN<32>) {
        payer.require_auth();
        bump_instance(&env);
        let key = DataKey::Invoice(invoice_hash.clone());
        let mut invoice = load(&env, &key);
        if invoice.status != Status::Open {
            panic_with_error!(&env, Error::AlreadyPaid);
        }

        // Record the payment before calling out to the token, so the invoice
        // can never be observed as open once its transfer has started.
        invoice.status = Status::Paid(Payment {
            payer: payer.clone(),
            ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
        });
        save(&env, &key, &invoice);

        token::Client::new(&env, &invoice.asset).transfer(
            &payer,
            &invoice.merchant,
            &invoice.amount,
        );

        InvoicePaid {
            invoice_number: invoice.invoice_number,
            payer,
            asset: invoice.asset,
            amount: invoice.amount,
            invoice_hash,
        }
        .publish(&env);
    }

    /// The invoice's status: `Open`, or `Paid` with the payer and ledger.
    pub fn status(env: Env, invoice_hash: BytesN<32>) -> Status {
        bump_instance(&env);
        load(&env, &DataKey::Invoice(invoice_hash)).status
    }

    /// The whole registered invoice, for a payer page to show before paying.
    pub fn get_invoice(env: Env, invoice_hash: BytesN<32>) -> Invoice {
        bump_instance(&env);
        load(&env, &DataKey::Invoice(invoice_hash))
    }
}

fn load(env: &Env, key: &DataKey) -> Invoice {
    let invoice: Invoice = env
        .storage()
        .persistent()
        .get(key)
        .unwrap_or_else(|| panic_with_error!(env, Error::UnknownInvoice));
    extend(env, key);
    invoice
}

fn save(env: &Env, key: &DataKey, invoice: &Invoice) {
    env.storage().persistent().set(key, invoice);
    extend(env, key);
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
