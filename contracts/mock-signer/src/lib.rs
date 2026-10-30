//! A stand-in for NEAR's MPC signer (`v1.signer`), for sandbox tests only.
//!
//! The real one signs with a key no one holds. This one holds nothing: a test registers the signature it wants
//! returned for a hash (it knows the key), and `sign` returns it in the shape the real signer uses, so the DAO
//! signer, the proposal flow and the way a signature is found on chain all run for real.

use near_sdk::json_types::Base64VecU8;
use near_sdk::store::LookupMap;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, PanicOnDefault};

#[near(serializers = [json])]
pub struct PayloadV2 {
    #[serde(rename = "Eddsa")]
    pub eddsa: String,
}

#[near(serializers = [json])]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: PayloadV2,
    pub domain_id: u32,
}

#[near(serializers = [json])]
pub struct SignResponse {
    pub scheme: String,
    pub signature: Vec<u8>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockSigner {
    public_key: String,
    path: String,
    signatures: LookupMap<String, Vec<u8>>,
}

#[near]
impl MockSigner {
    #[init]
    pub fn new(public_key: String, path: String) -> Self {
        Self { public_key, path, signatures: LookupMap::new(b"s".to_vec()) }
    }

    /// The key a DAO's owner path would derive. Answers only for the path it was made for.
    pub fn derived_public_key(&self, path: String, predecessor: AccountId, domain_id: u32) -> String {
        let _ = (predecessor, domain_id);
        require!(path == self.path, "no key for this path");
        self.public_key.clone()
    }

    /// Test helper: the signature `sign` should return for a hash (hex).
    pub fn register(&mut self, hash: String, signature: Base64VecU8) {
        self.signatures.insert(hash.to_lowercase(), signature.0);
    }

    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> SignResponse {
        assert_one_yocto();
        require!(request.path == self.path, "not the registered path");
        let hash = request.payload_v2.eddsa.to_lowercase();
        let signature = self.signatures.get(&hash).cloned().unwrap_or_else(|| env::panic_str("no signature registered for this hash"));
        SignResponse { scheme: "Ed25519".to_string(), signature }
    }

    /// Token stand-ins, so a funding proposal (which registers an address and then transfers) has something to call.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) {
        let _ = (account_id, registration_only);
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: String, memo: Option<String>) {
        assert_one_yocto();
        let _ = (receiver_id, memo);
        require!(amount.parse::<u128>().is_ok(), "amount must be a number");
    }

    /// A harmless call for a delegate action to make.
    pub fn ping(&self) -> bool {
        true
    }
}
