// Keep the retention state-machine tests independent from a real PostgreSQL
// instance.  Production database E2E remains an explicit protected-env gate.
use reader_sync_api::intelligence_retention::{
    PURGE_STEPS, exact_thirty_day_expiry, is_expired_at,
};

#[test]
fn expiry_boundary_matches_public_read_gate() {
    assert!(is_expired_at(100, 100));
    assert!(is_expired_at(99, 100));
    assert!(!is_expired_at(101, 100));
    assert!(exact_thirty_day_expiry(5, 5 + 30 * 24 * 60 * 60 * 1_000));
    assert!(!exact_thirty_day_expiry(
        5,
        5 + 30 * 24 * 60 * 60 * 1_000 - 1
    ));
}

#[test]
fn cleanup_order_is_reference_safe() {
    let position = |name| PURGE_STEPS.iter().position(|step| *step == name).unwrap();
    assert!(
        position("delete_account_delivery_references")
            < position("delete_publication_asset_references")
    );
    assert!(
        position("delete_publication_asset_references") < position("delete_unreferenced_images")
    );
    assert!(position("delete_unreferenced_images") < position("delete_publication_content"));
}
