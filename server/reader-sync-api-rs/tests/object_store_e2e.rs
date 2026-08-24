//! Opt-in real S3-compatible object-store verification.
//!
//! The test is inert unless every `KUNPENG_SYNC_OBJECT_STORE_E2E_*` variable
//! is supplied.  It only writes a fresh, bounded `intelligence/e2e/` key and
//! always attempts to delete it before returning.

use std::env;

use secrecy::SecretString;
use uuid::Uuid;

use reader_sync_api::{
    config::{IntelligenceObjectStorageConfig, S3ObjectStorageConfig},
    intelligence_object_store::{IntelligenceObjectStore, store_for_config},
};

fn configured_store() -> Result<Box<dyn IntelligenceObjectStore>, String> {
    let endpoint = required_environment("KUNPENG_SYNC_OBJECT_STORE_E2E_ENDPOINT")?;
    let bucket = required_environment("KUNPENG_SYNC_OBJECT_STORE_E2E_BUCKET")?;
    let access_key_id = required_environment("KUNPENG_SYNC_OBJECT_STORE_E2E_ACCESS_KEY_ID")?;
    let secret_access_key =
        required_environment("KUNPENG_SYNC_OBJECT_STORE_E2E_SECRET_ACCESS_KEY")?;
    let region = env::var("KUNPENG_SYNC_OBJECT_STORE_E2E_REGION")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "us-east-1".to_owned());
    store_for_config(&IntelligenceObjectStorageConfig::S3(
        S3ObjectStorageConfig {
            endpoint,
            region,
            bucket,
            access_key_id: SecretString::from(access_key_id),
            secret_access_key: SecretString::from(secret_access_key),
            session_token: None,
        },
    ))
    .map_err(|_| "object-store test configuration is invalid".to_owned())
}

fn required_environment(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("real object-store E2E requires {name}"))
}

#[test]
#[ignore = "requires explicit real object-store confirmation and protected credentials"]
fn real_s3_put_range_delete_round_trip() {
    let store = configured_store().expect("configured real object store");
    store.health().expect("configured test bucket is reachable");
    let key = format!("intelligence/e2e/{}.bin", Uuid::new_v4());
    let payload = b"kunpeng-object-store-e2e-v1";
    store.put(&key, payload).expect("put test object");

    let full = store.get_range(&key, 0, None).expect("get complete object");
    assert_eq!(full.bytes, payload);
    assert_eq!(full.total_size, Some(u64::try_from(payload.len()).unwrap()));

    let range = store
        .get_range(&key, 2, Some(8))
        .expect("get bounded range");
    assert_eq!(range.bytes, payload[2..=8]);
    assert_eq!(
        range.total_size,
        Some(u64::try_from(payload.len()).unwrap())
    );

    store.delete(&key).expect("delete test object");
}

#[test]
#[ignore = "requires explicit real object-store outage confirmation and protected credentials"]
fn real_s3_unavailable_is_a_stable_operation_failure() {
    if env::var_os("KUNPENG_SYNC_OBJECT_STORE_E2E_EXPECT_UNAVAILABLE").is_none() {
        return;
    }
    let store = configured_store().expect("configured outage-test object store");
    let key = format!("intelligence/e2e/unavailable-{}.bin", Uuid::new_v4());
    assert!(store.put(&key, b"unavailable").is_err());
}
