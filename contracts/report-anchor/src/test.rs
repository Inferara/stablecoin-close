extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger as _},
    xdr::{self, ScVal},
    IntoVal, Symbol, TryFromVal, Val,
};

struct Setup<'a> {
    env: Env,
    contract: Address,
    client: ReportAnchorClient<'a>,
    signer: Address,
    company: BytesN<32>,
    period: String,
    report: BytesN<32>,
}

fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| {
        l.sequence_number = 4242;
        l.timestamp = 1_761_955_200;
    });
    let contract = env.register(ReportAnchor, ());
    let client = ReportAnchorClient::new(&env, &contract);
    Setup {
        signer: Address::generate(&env),
        company: BytesN::from_array(&env, &[1u8; 32]),
        period: String::from_str(&env, "2026-10"),
        report: BytesN::from_array(&env, &[0xabu8; 32]),
        env,
        contract,
        client,
    }
}

fn sc<T: IntoVal<Env, Val>>(env: &Env, v: T) -> ScVal {
    ScVal::try_from_val(env, &v.into_val(env)).unwrap()
}

#[test]
fn get_before_anchoring_is_none() {
    let s = setup();
    assert_eq!(s.client.get(&s.company, &s.period), None);
}

#[test]
fn anchor_then_get() {
    let s = setup();
    s.client.anchor(&s.signer, &s.company, &s.period, &s.report);
    assert_eq!(
        s.client.get(&s.company, &s.period),
        Some(Anchor {
            report_sha256: s.report.clone(),
            signer: s.signer.clone(),
            ledger: 4242,
            timestamp: 1_761_955_200,
        })
    );
    // Other periods and other companies are untouched.
    assert_eq!(
        s.client
            .get(&s.company, &String::from_str(&s.env, "2026-09")),
        None
    );
    assert_eq!(
        s.client
            .get(&BytesN::from_array(&s.env, &[2u8; 32]), &s.period),
        None
    );
}

#[test]
fn anchor_requires_signer_auth() {
    let s = setup();
    s.client.anchor(&s.signer, &s.company, &s.period, &s.report);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.signer.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.contract.clone(),
                    Symbol::new(&s.env, "anchor"),
                    (
                        s.signer.clone(),
                        s.company.clone(),
                        s.period.clone(),
                        s.report.clone()
                    )
                        .into_val(&s.env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
}

#[test]
fn anchor_without_auth_is_refused() {
    let s = setup();
    s.env.set_auths(&[]);
    assert!(s
        .client
        .try_anchor(&s.signer, &s.company, &s.period, &s.report)
        .is_err());
    assert_eq!(s.client.get(&s.company, &s.period), None);
}

#[test]
fn second_anchor_for_the_same_period_is_refused() {
    let s = setup();
    s.client.anchor(&s.signer, &s.company, &s.period, &s.report);
    let other = BytesN::from_array(&s.env, &[0xcdu8; 32]);
    for hash in [&s.report, &other] {
        assert_eq!(
            s.client.try_anchor(&s.signer, &s.company, &s.period, hash),
            Err(Ok(Error::AlreadyAnchored.into()))
        );
    }
    // A different signer cannot overwrite it either.
    let someone = Address::generate(&s.env);
    assert_eq!(
        s.client.try_anchor(&someone, &s.company, &s.period, &other),
        Err(Ok(Error::AlreadyAnchored.into()))
    );
    assert_eq!(
        s.client.get(&s.company, &s.period).unwrap().report_sha256,
        s.report
    );
}

#[test]
fn malformed_periods_are_refused() {
    let s = setup();
    for bad in [
        "2026-13",
        "2026-00",
        "2026-1",
        "2026/10",
        "26-10",
        "2026-10-01",
        "abcd-ef",
        "",
    ] {
        let p = String::from_str(&s.env, bad);
        assert_eq!(
            s.client.try_anchor(&s.signer, &s.company, &p, &s.report),
            Err(Ok(Error::InvalidPeriod.into())),
            "{bad}"
        );
    }
    for good in ["2026-01", "2026-12", "1999-07"] {
        let p = String::from_str(&s.env, good);
        s.client.anchor(&s.signer, &s.company, &p, &s.report);
    }
}

#[test]
fn anchored_event_has_the_documented_shape() {
    let s = setup();
    s.client.anchor(&s.signer, &s.company, &s.period, &s.report);

    let events = s.env.events().all().filter_by_contract(&s.contract);
    let events = events.events();
    assert_eq!(events.len(), 1);
    let xdr::ContractEventBody::V0(body) = &events[0].body;
    let topics: std::vec::Vec<ScVal> = body.topics.iter().cloned().collect();
    assert_eq!(
        topics,
        std::vec![
            ScVal::Symbol("anchored".try_into().unwrap()),
            ScVal::Bytes(xdr::ScBytes([1u8; 32].try_into().unwrap())),
            ScVal::String(xdr::ScString("2026-10".try_into().unwrap())),
        ]
    );
    let ScVal::Map(Some(map)) = &body.data else {
        panic!("data is not a map: {:?}", body.data)
    };
    let entries: std::vec::Vec<(ScVal, ScVal)> =
        map.iter().map(|e| (e.key.clone(), e.val.clone())).collect();
    assert_eq!(
        entries,
        std::vec![
            (
                ScVal::Symbol("report_sha256".try_into().unwrap()),
                ScVal::Bytes(xdr::ScBytes([0xabu8; 32].try_into().unwrap())),
            ),
            (
                ScVal::Symbol("signer".try_into().unwrap()),
                sc(&s.env, s.signer.clone())
            ),
        ]
    );
}
