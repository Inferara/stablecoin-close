extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    xdr::{self, ScVal},
    IntoVal, Symbol, TryFromVal, Val,
};

const AMOUNT: i128 = 1_200_0000000; // 1,200.0000000 in stroops

struct Setup<'a> {
    env: Env,
    contract: Address,
    client: InvoiceSettlementClient<'a>,
    merchant: Address,
    payer: Address,
    asset: Address,
    token: TokenClient<'a>,
    hash: BytesN<32>,
    number: String,
}

fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| {
        l.sequence_number = 1000;
        l.timestamp = 1_760_000_000;
    });

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let asset = sac.address();
    let merchant = Address::generate(&env);
    let payer = Address::generate(&env);
    StellarAssetClient::new(&env, &asset).mint(&payer, &(AMOUNT * 2));

    let contract = env.register(InvoiceSettlement, ());
    let client = InvoiceSettlementClient::new(&env, &contract);
    let hash = BytesN::from_array(&env, &[7u8; 32]);
    let number = String::from_str(&env, "INV-1001");
    let token = TokenClient::new(&env, &asset);
    Setup {
        env,
        contract,
        client,
        merchant,
        payer,
        asset,
        token,
        hash,
        number,
    }
}

fn register(s: &Setup) {
    s.client.register_invoice(
        &s.merchant,
        &s.number,
        &s.hash,
        &s.asset,
        &AMOUNT,
        &1_762_000_000,
    );
}

fn sc<T: IntoVal<Env, Val>>(env: &Env, v: T) -> ScVal {
    ScVal::try_from_val(env, &v.into_val(env)).unwrap()
}

#[test]
fn register_then_read_back() {
    let s = setup();
    register(&s);
    assert_eq!(s.client.status(&s.hash), Status::Open);
    assert_eq!(
        s.client.get_invoice(&s.hash),
        Invoice {
            merchant: s.merchant.clone(),
            invoice_number: s.number.clone(),
            asset: s.asset.clone(),
            amount: AMOUNT,
            due: 1_762_000_000,
            status: Status::Open,
        }
    );
}

#[test]
fn register_requires_merchant_auth() {
    let s = setup();
    register(&s);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.merchant.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.contract.clone(),
                    Symbol::new(&s.env, "register_invoice"),
                    (
                        s.merchant.clone(),
                        s.number.clone(),
                        s.hash.clone(),
                        s.asset.clone(),
                        AMOUNT,
                        1_762_000_000u64,
                    )
                        .into_val(&s.env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
}

#[test]
fn register_without_auth_is_refused() {
    let s = setup();
    s.env.set_auths(&[]);
    let r = s.client.try_register_invoice(
        &s.merchant,
        &s.number,
        &s.hash,
        &s.asset,
        &AMOUNT,
        &1_762_000_000,
    );
    assert!(r.is_err());
    assert_eq!(
        s.client.try_status(&s.hash),
        Err(Ok(Error::UnknownInvoice.into()))
    );
}

#[test]
fn register_twice_is_refused() {
    let s = setup();
    register(&s);
    let r = s.client.try_register_invoice(
        &s.merchant,
        &s.number,
        &s.hash,
        &s.asset,
        &1,
        &1_762_000_000,
    );
    assert_eq!(r, Err(Ok(Error::AlreadyRegistered.into())));
}

#[test]
fn register_refuses_non_positive_amount_and_empty_number() {
    let s = setup();
    for bad in [0i128, -5] {
        let r = s
            .client
            .try_register_invoice(&s.merchant, &s.number, &s.hash, &s.asset, &bad, &0);
        assert_eq!(r, Err(Ok(Error::InvalidAmount.into())));
    }
    let empty = String::from_str(&s.env, "");
    let r = s
        .client
        .try_register_invoice(&s.merchant, &empty, &s.hash, &s.asset, &AMOUNT, &0);
    assert_eq!(r, Err(Ok(Error::EmptyInvoiceNumber.into())));
}

#[test]
fn pay_moves_the_registered_amount_and_marks_paid() {
    let s = setup();
    register(&s);
    s.client.pay_invoice(&s.payer, &s.hash);

    assert_eq!(s.token.balance(&s.merchant), AMOUNT);
    assert_eq!(s.token.balance(&s.payer), AMOUNT);
    assert_eq!(s.token.balance(&s.contract), 0);
    assert_eq!(
        s.client.status(&s.hash),
        Status::Paid(Payment {
            payer: s.payer.clone(),
            ledger: 1000,
            timestamp: 1_760_000_000,
        })
    );
}

#[test]
fn pay_requires_payer_auth_covering_the_transfer() {
    let s = setup();
    register(&s);
    s.client.pay_invoice(&s.payer, &s.hash);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.payer.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.contract.clone(),
                    Symbol::new(&s.env, "pay_invoice"),
                    (s.payer.clone(), s.hash.clone()).into_val(&s.env),
                )),
                sub_invocations: std::vec![AuthorizedInvocation {
                    function: AuthorizedFunction::Contract((
                        s.asset.clone(),
                        Symbol::new(&s.env, "transfer"),
                        (s.payer.clone(), s.merchant.clone(), AMOUNT).into_val(&s.env),
                    )),
                    sub_invocations: std::vec![],
                }],
            }
        )]
    );
}

#[test]
fn pay_without_auth_is_refused() {
    let s = setup();
    register(&s);
    s.env.set_auths(&[]);
    assert!(s.client.try_pay_invoice(&s.payer, &s.hash).is_err());
    assert_eq!(s.client.status(&s.hash), Status::Open);
    assert_eq!(s.token.balance(&s.merchant), 0);
}

#[test]
fn paying_twice_is_refused() {
    let s = setup();
    register(&s);
    s.client.pay_invoice(&s.payer, &s.hash);
    assert_eq!(
        s.client.try_pay_invoice(&s.payer, &s.hash),
        Err(Ok(Error::AlreadyPaid.into()))
    );
    // A different payer cannot pay it again either.
    let other = Address::generate(&s.env);
    assert_eq!(
        s.client.try_pay_invoice(&other, &s.hash),
        Err(Ok(Error::AlreadyPaid.into()))
    );
    assert_eq!(s.token.balance(&s.merchant), AMOUNT);
}

#[test]
fn paying_an_unknown_invoice_is_refused() {
    let s = setup();
    let unknown = BytesN::from_array(&s.env, &[9u8; 32]);
    assert_eq!(
        s.client.try_pay_invoice(&s.payer, &unknown),
        Err(Ok(Error::UnknownInvoice.into()))
    );
    assert_eq!(
        s.client.try_status(&unknown),
        Err(Ok(Error::UnknownInvoice.into()))
    );
    assert_eq!(s.token.balance(&s.payer), AMOUNT * 2);
}

#[test]
fn a_payer_without_funds_leaves_the_invoice_open() {
    let s = setup();
    register(&s);
    let broke = Address::generate(&s.env);
    assert!(s.client.try_pay_invoice(&broke, &s.hash).is_err());
    assert_eq!(s.client.status(&s.hash), Status::Open);
}

#[test]
fn invoice_paid_event_has_the_agreed_shape() {
    let s = setup();
    register(&s);
    s.client.pay_invoice(&s.payer, &s.hash);

    let events = s.env.events().all().filter_by_contract(&s.contract);
    let events = events.events();
    assert_eq!(events.len(), 1);
    let e = &events[0];
    assert_eq!(e.type_, xdr::ContractEventType::Contract);
    let xdr::ContractEventBody::V0(body) = &e.body;

    // topics = [Symbol "invoice_paid", String invoice_number]
    let topics: std::vec::Vec<ScVal> = body.topics.iter().cloned().collect();
    assert_eq!(
        topics,
        std::vec![
            ScVal::Symbol("invoice_paid".try_into().unwrap()),
            ScVal::String(xdr::ScString("INV-1001".try_into().unwrap())),
        ]
    );

    // data = map { amount, asset, invoice_hash, payer } (keys sorted, nothing else)
    let ScVal::Map(Some(map)) = &body.data else {
        panic!("data is not a map: {:?}", body.data)
    };
    let entries: std::vec::Vec<(ScVal, ScVal)> =
        map.iter().map(|e| (e.key.clone(), e.val.clone())).collect();
    assert_eq!(
        entries,
        std::vec![
            (
                ScVal::Symbol("amount".try_into().unwrap()),
                sc(&s.env, AMOUNT)
            ),
            (
                ScVal::Symbol("asset".try_into().unwrap()),
                sc(&s.env, s.asset.clone())
            ),
            (
                ScVal::Symbol("invoice_hash".try_into().unwrap()),
                ScVal::Bytes(xdr::ScBytes([7u8; 32].try_into().unwrap())),
            ),
            (
                ScVal::Symbol("payer".try_into().unwrap()),
                sc(&s.env, s.payer.clone())
            ),
        ]
    );
}
