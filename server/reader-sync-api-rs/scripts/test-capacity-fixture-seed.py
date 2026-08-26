#!/usr/bin/env python3
"""Offline safety tests for capacity-fixture-seed.py.

These tests exercise pure construction and rejection paths only.  They never
invoke systemd, read procfs, connect to PostgreSQL, or create a real token file,
so they are safe to run on Windows development hosts.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import pathlib
import sys
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).with_name("capacity-fixture-seed.py")
SPEC = importlib.util.spec_from_file_location("capacity_fixture_seed", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("capacity fixture seed module could not be loaded")
SEEDER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SEEDER
SPEC.loader.exec_module(SEEDER)

TEST_KEY = b"test-only-key-with-at-least-32-bytes"
FIXTURE_ID = "a1b2c3d4"
TEST_DATABASE_URL = (
    b"postgresql://fixture:secret@127.0.0.1:5433/"
    b"reader_sync_rust_test_capacity?sslmode=disable"
)
TARGET_FINGERPRINT = hashlib.sha256(TEST_DATABASE_URL + b"\0" + TEST_KEY).hexdigest()


def deterministic_tokens():
    values = iter(range(SEEDER.ACCOUNT_COUNT))
    return lambda: f"{next(values):096x}"


def cleanup_report(deleted_accounts=SEEDER.ACCOUNT_COUNT):
    report = {key: 0 for key in SEEDER.CLEANUP_REPORT_KEYS}
    report["ok"] = True
    report["requestedAccountCount"] = SEEDER.ACCOUNT_COUNT
    report["deletedAccountCount"] = deleted_accounts
    return report


class RuntimeGateTests(unittest.TestCase):
    def test_runtime_rejects_windows_and_non_root_linux(self):
        with self.assertRaises(SEEDER.FixtureSeedError):
            SEEDER.validate_runtime("win32", 0)
        with self.assertRaises(SEEDER.FixtureSeedError):
            SEEDER.validate_runtime("linux", 1000)
        SEEDER.validate_runtime("linux", 0)

    def test_service_name_requires_dev_test_and_rejects_production(self):
        accepted = "kunpeng-reader-sync-dev-test.service"
        self.assertEqual(SEEDER.validate_service_name(accepted), accepted)
        for rejected in (
            "kunpeng-reader-sync.service",
            "kunpeng-reader-prod-dev-test.service",
            "../dev-test.service",
            "--dev-test",
        ):
            with self.subTest(rejected=rejected):
                with self.assertRaises(SEEDER.FixtureSeedError):
                    SEEDER.validate_service_name(rejected)

    def test_fixture_id_is_short_and_shell_inert(self):
        self.assertEqual(SEEDER.validate_fixture_id(FIXTURE_ID), FIXTURE_ID)
        for rejected in ("short", "UPPERCASE1", "fixture-id", "a" * 17, "x;select1"):
            with self.subTest(rejected=rejected):
                with self.assertRaises(SEEDER.FixtureSeedError):
                    SEEDER.validate_fixture_id(rejected)

    def test_token_output_requires_a_normalized_posix_absolute_path(self):
        accepted = "/private/capacity/token-pool.txt"
        self.assertEqual(SEEDER.validate_token_output_path(accepted), accepted)
        for rejected in (
            "relative/token-pool.txt",
            "/private/../token-pool.txt",
            "/",
            "/private/capacity/",
            "/private/capacity/token\nfile",
        ):
            with self.subTest(rejected=rejected):
                with self.assertRaises(SEEDER.FixtureSeedError):
                    SEEDER.validate_token_output_path(rejected)

    def test_main_refuses_windows_before_any_remote_or_file_operation(self):
        sensitive_path = "/private/sensitive-token-output"
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = SEEDER.main(
                [
                    "seed",
                    "--service",
                    "reader-dev-test.service",
                    "--fixture-id",
                    FIXTURE_ID,
                    "--token-output",
                    sensitive_path,
                    "--expected-target-fingerprint",
                    TARGET_FINGERPRINT,
                ],
                platform_name="win32",
                effective_uid=0,
            )
        self.assertEqual(result, 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn(sensitive_path, stderr.getvalue())
        self.assertIn("require Linux", stderr.getvalue())

    def test_main_refuses_non_root_without_echoing_arguments(self):
        sensitive_path = "/private/sensitive-token-output"
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = SEEDER.main(
                [
                    "seed",
                    "--service",
                    "reader-dev-test.service",
                    "--fixture-id",
                    FIXTURE_ID,
                    "--token-output",
                    sensitive_path,
                    "--expected-target-fingerprint",
                    TARGET_FINGERPRINT,
                ],
                platform_name="linux",
                effective_uid=1000,
            )
        self.assertEqual(result, 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn(sensitive_path, stderr.getvalue())
        self.assertIn("require root", stderr.getvalue())


class EnvironmentGateTests(unittest.TestCase):
    def test_target_fingerprint_requires_exact_lowercase_sha256(self):
        self.assertEqual(
            SEEDER.validate_target_fingerprint(TARGET_FINGERPRINT),
            TARGET_FINGERPRINT,
        )
        for rejected in (
            "",
            TARGET_FINGERPRINT.upper(),
            TARGET_FINGERPRINT[:-1],
            TARGET_FINGERPRINT + "0",
            "g" * 64,
        ):
            with self.subTest(rejected=rejected):
                with self.assertRaises(SEEDER.FixtureSeedError):
                    SEEDER.validate_target_fingerprint(rejected)

    def test_process_environment_extracts_only_current_test_values(self):
        blob = (
            b"UNRELATED_SECRET=must-not-be-returned\0"
            b"KUNPENG_SYNC_TOKEN_HMAC_KEY="
            + TEST_KEY
            + b"\0KUNPENG_SYNC_DATABASE_URL="
            + TEST_DATABASE_URL
            + b"\0"
        )
        environment = SEEDER.extract_service_environment(blob)
        self.assertEqual(environment.token_hmac_key, TEST_KEY)
        self.assertEqual(environment.database.name, "reader_sync_rust_test_capacity")
        self.assertEqual(environment.database.port, 5433)
        self.assertEqual(environment.target_fingerprint, TARGET_FINGERPRINT)
        self.assertFalse(hasattr(environment, "database_url"))

    def test_fingerprint_preserves_raw_database_url_binding(self):
        first = SEEDER.extract_service_environment(
            b"KUNPENG_SYNC_TOKEN_HMAC_KEY="
            + TEST_KEY
            + b"\0KUNPENG_SYNC_DATABASE_URL=postgresql://127.0.0.1/"
            b"reader_sync_rust_test_capacity\0"
        )
        second = SEEDER.extract_service_environment(
            b"KUNPENG_SYNC_TOKEN_HMAC_KEY="
            + TEST_KEY
            + b"\0KUNPENG_SYNC_DATABASE_URL=postgresql://localhost/"
            b"reader_sync_rust_test_capacity\0"
        )
        self.assertEqual(first.database, second.database)
        self.assertNotEqual(first.target_fingerprint, second.target_fingerprint)

    def test_database_target_rejects_remote_or_non_test_database(self):
        rejected = (
            "postgresql://user:secret@example.invalid/reader_sync_rust_test_capacity",
            "postgresql://user:secret@127.0.0.1/production",
            "https://127.0.0.1/reader_sync_rust_test_capacity",
            "postgresql://user:secret@127.0.0.1/reader_sync_rust_test_bad-name",
        )
        for value in rejected:
            with self.subTest(value=value):
                with self.assertRaises(SEEDER.FixtureSeedError):
                    SEEDER.parse_database_target(value)

    def test_process_environment_rejects_missing_duplicate_or_short_key(self):
        valid_database = (
            b"KUNPENG_SYNC_DATABASE_URL="
            b"postgresql://127.0.0.1/reader_sync_rust_test_capacity\0"
        )
        rejected = (
            valid_database,
            b"KUNPENG_SYNC_TOKEN_HMAC_KEY=short\0" + valid_database,
            b"KUNPENG_SYNC_TOKEN_HMAC_KEY="
            + TEST_KEY
            + b"\0KUNPENG_SYNC_TOKEN_HMAC_KEY="
            + TEST_KEY
            + b"\0"
            + valid_database,
        )
        for blob in rejected:
            with self.subTest(blob_length=len(blob)):
                with self.assertRaises(SEEDER.FixtureSeedError):
                    SEEDER.extract_service_environment(blob)


class CredentialAndManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.identities = SEEDER.build_identities(FIXTURE_ID, TEST_KEY)
        cls.rows = SEEDER.build_seed_rows(
            cls.identities,
            TEST_KEY,
            deterministic_tokens(),
        )

    def test_session_hmac_matches_a_fixed_domain_separated_vector(self):
        digest = SEEDER.session_token_digest(TEST_KEY, "00" * 48)
        self.assertEqual(
            digest.hex(),
            "a03180f072be05f345b42be8f02dc4bdd3044d356e1727299a4660eb2a82d303",
        )

    def test_manifest_has_exactly_2048_unique_accounts_and_tokens(self):
        self.assertEqual(len(self.identities), SEEDER.ACCOUNT_COUNT)
        self.assertEqual(len(self.rows), SEEDER.ACCOUNT_COUNT)
        self.assertEqual(
            len({identity.user_id for identity in self.identities}),
            SEEDER.ACCOUNT_COUNT,
        )
        self.assertEqual(
            len({row.token for row in self.rows}),
            SEEDER.ACCOUNT_COUNT,
        )
        self.assertEqual(
            len({row.session_digest_hex for row in self.rows}),
            SEEDER.ACCOUNT_COUNT,
        )
        self.assertTrue(all(len(row.token) == 96 for row in self.rows))
        self.assertTrue(all(len(row.session_digest_hex) == 64 for row in self.rows))

    def test_database_copy_payload_contains_digests_but_no_plaintext_tokens(self):
        payload = SEEDER.seed_copy_csv(self.rows)
        self.assertEqual(len(payload.splitlines()), SEEDER.ACCOUNT_COUNT)
        self.assertNotIn(self.rows[0].token, payload)
        self.assertNotIn(self.rows[-1].token, payload)
        self.assertIn(self.rows[0].session_digest_hex, payload)

    def test_token_file_payload_is_one_unique_token_per_line(self):
        payload = SEEDER.token_file_payload(self.rows).decode("ascii")
        lines = payload.splitlines()
        self.assertEqual(len(lines), SEEDER.ACCOUNT_COUNT)
        self.assertEqual(len(set(lines)), SEEDER.ACCOUNT_COUNT)
        self.assertTrue(payload.endswith("\n"))

    def test_duplicate_token_factory_is_rejected(self):
        with self.assertRaises(SEEDER.FixtureSeedError):
            SEEDER.build_seed_rows(
                self.identities,
                TEST_KEY,
                lambda: "00" * 48,
            )


class TransactionConstructionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        identities = SEEDER.build_identities(FIXTURE_ID, TEST_KEY)
        cls.rows = SEEDER.build_seed_rows(identities, TEST_KEY, deterministic_tokens())
        cls.seed_sql = SEEDER.render_seed_sql(FIXTURE_ID, cls.rows)
        cls.cleanup_sql = SEEDER.render_cleanup_sql(FIXTURE_ID, identities)
        cls.allow_absent_cleanup_sql = SEEDER.render_cleanup_sql(
            FIXTURE_ID,
            identities,
            allow_absent=True,
        )

    def test_seed_sql_has_all_destructive_and_migration_guards(self):
        required = (
            "BEGIN;",
            "pg_advisory_xact_lock",
            "current_database()",
            "reader_sync_rust_test_",
            "sync_protocol_version",
            "users_initialize_account_data_generation_v4",
            "users_initialize_account_storage_usage_v5",
            "COPY capacity_fixture_seed",
            "INSERT INTO users",
            "INSERT INTO auth_sessions_v4",
            "account_data_generations",
            "account_storage_usage_v5",
            "COMMIT;",
        )
        for text in required:
            with self.subTest(text=text):
                self.assertIn(text, self.seed_sql)

    def test_seed_sql_never_contains_plaintext_tokens_or_hmac_key(self):
        self.assertNotIn(self.rows[0].token, self.seed_sql)
        self.assertNotIn(self.rows[-1].token, self.seed_sql)
        self.assertNotIn(TEST_KEY.decode("ascii"), self.seed_sql)

    def test_current_v5_seed_uses_the_post_history_storage_ledger_shape(self):
        self.assertIn("l.entity_bytes=0 AND l.asset_bytes=0", self.seed_sql)
        self.assertNotIn("l.history_bytes", self.seed_sql)

    def test_current_v5_cleanup_does_not_require_the_retired_history_table(self):
        self.assertNotIn("sync_entity_history_v4", self.cleanup_sql)
        self.assertIn("'remainingHistoryCount',0", self.cleanup_sql)

    def test_cleanup_is_exact_manifest_deletion_not_prefix_deletion(self):
        self.assertIn("DELETE FROM users u USING capacity_fixture_cleanup c", self.cleanup_sql)
        self.assertIn("u.id=c.user_id", self.cleanup_sql)
        self.assertIn("authenticated_account_minute", self.cleanup_sql)
        self.assertNotIn("DELETE FROM users WHERE id LIKE", self.cleanup_sql)
        self.assertNotIn("TRUNCATE", self.cleanup_sql.upper())

    def test_allow_absent_is_explicit_and_still_checks_all_identity_columns(self):
        self.assertIn("IF true AND candidate_count=0 AND matching_count=0", self.allow_absent_cleanup_sql)
        self.assertIn("IF false AND candidate_count=0 AND matching_count=0", self.cleanup_sql)
        self.assertIn("u.id=c.user_id OR u.username=c.user_id", self.allow_absent_cleanup_sql)
        self.assertIn("OR u.username_key=c.user_id", self.allow_absent_cleanup_sql)

    def test_psql_transaction_has_a_bounded_inner_deadline(self):
        completed = mock.Mock(returncode=0, stdout=b"ok\n")
        with (
            mock.patch.object(
                SEEDER,
                "_trusted_executable",
                side_effect=["/trusted/sudo", "/trusted/psql"],
            ),
            mock.patch.object(
                SEEDER.subprocess,
                "run",
                return_value=completed,
            ) as run,
        ):
            output = SEEDER._execute_psql(
                SEEDER.DatabaseTarget(
                    name="reader_sync_rust_test_capacity",
                    port=5432,
                ),
                "SELECT 1;",
            )
        self.assertEqual(output, b"ok\n")
        self.assertEqual(run.call_args.kwargs["timeout"], 30)


class CleanupRecoveryTests(unittest.TestCase):
    @staticmethod
    def service_environment():
        return SEEDER.ServiceEnvironment(
            token_hmac_key=TEST_KEY,
            database=SEEDER.DatabaseTarget(
                name="reader_sync_rust_test_capacity",
                port=5432,
            ),
            target_fingerprint=TARGET_FINGERPRINT,
        )

    def test_seed_target_drift_fails_before_identity_token_or_sql_work(self):
        with (
            mock.patch.object(
                SEEDER,
                "read_running_service_environment",
                return_value=self.service_environment(),
            ),
            mock.patch.object(SEEDER, "build_identities") as build_identities,
            mock.patch.object(SEEDER, "_write_token_file") as write_tokens,
            mock.patch.object(SEEDER, "_execute_psql") as execute_psql,
        ):
            with self.assertRaises(SEEDER.FixtureSeedError):
                SEEDER.seed_fixture(
                    "reader-dev-test.service",
                    FIXTURE_ID,
                    "/private/new-token-output",
                    expected_target_fingerprint="f" * 64,
                )
        build_identities.assert_not_called()
        write_tokens.assert_not_called()
        execute_psql.assert_not_called()

    def test_cleanup_target_drift_fails_before_identity_or_sql_work(self):
        with (
            mock.patch.object(
                SEEDER,
                "read_running_service_environment",
                return_value=self.service_environment(),
            ),
            mock.patch.object(SEEDER, "build_identities") as build_identities,
            mock.patch.object(SEEDER, "_execute_psql") as execute_psql,
        ):
            with self.assertRaises(SEEDER.FixtureSeedError):
                SEEDER.cleanup_fixture(
                    "reader-dev-test.service",
                    FIXTURE_ID,
                    allow_absent=True,
                    expected_target_fingerprint="f" * 64,
                )
        build_identities.assert_not_called()
        execute_psql.assert_not_called()

    def test_count_gate_accepts_only_absent_or_complete_when_enabled(self):
        SEEDER.validate_cleanup_target_counts(
            SEEDER.ACCOUNT_COUNT,
            SEEDER.ACCOUNT_COUNT,
        )
        SEEDER.validate_cleanup_target_counts(0, 0, allow_absent=True)
        SEEDER.validate_cleanup_target_counts(
            SEEDER.ACCOUNT_COUNT,
            SEEDER.ACCOUNT_COUNT,
            allow_absent=True,
        )
        with self.assertRaises(SEEDER.FixtureSeedError):
            SEEDER.validate_cleanup_target_counts(0, 0)
        for candidate_count, matching_count in (
            (1, 1),
            (SEEDER.ACCOUNT_COUNT - 1, SEEDER.ACCOUNT_COUNT - 1),
            (SEEDER.ACCOUNT_COUNT, SEEDER.ACCOUNT_COUNT - 1),
            (1, 0),
            (0, 1),
        ):
            with self.subTest(
                candidate_count=candidate_count,
                matching_count=matching_count,
            ):
                with self.assertRaises(SEEDER.FixtureSeedError):
                    SEEDER.validate_cleanup_target_counts(
                        candidate_count,
                        matching_count,
                        allow_absent=True,
                    )

    def test_allow_absent_report_accepts_zero_deleted_but_strict_rejects_it(self):
        report = cleanup_report(deleted_accounts=0)
        self.assertEqual(
            SEEDER.validate_cleanup_report(report, allow_absent=True),
            report,
        )
        with self.assertRaises(SEEDER.FixtureSeedError):
            SEEDER.validate_cleanup_report(report)

    def test_allow_absent_report_rejects_partial_delete(self):
        with self.assertRaises(SEEDER.FixtureSeedError):
            SEEDER.validate_cleanup_report(
                cleanup_report(deleted_accounts=SEEDER.ACCOUNT_COUNT - 1),
                allow_absent=True,
            )

    def test_committed_seed_report_failure_attempts_cleanup_then_unlinks_tokens(self):
        environment = SEEDER.ServiceEnvironment(
            token_hmac_key=TEST_KEY,
            database=SEEDER.DatabaseTarget(
                name="reader_sync_rust_test_capacity",
                port=5432,
            ),
            target_fingerprint=TARGET_FINGERPRINT,
        )
        identities = SEEDER.build_identities(FIXTURE_ID, TEST_KEY)
        rows = SEEDER.build_seed_rows(identities, TEST_KEY, deterministic_tokens())
        cleanup_output = (
            __import__("json").dumps(cleanup_report()).encode("utf-8") + b"\n"
        )
        with (
            mock.patch.object(
                SEEDER,
                "read_running_service_environment",
                return_value=environment,
            ),
            mock.patch.object(SEEDER, "build_identities", return_value=identities),
            mock.patch.object(SEEDER, "build_seed_rows", return_value=rows),
            mock.patch.object(SEEDER, "_write_token_file") as write_tokens,
            mock.patch.object(
                SEEDER,
                "_execute_psql",
                side_effect=[b"invalid-report\n", cleanup_output],
            ) as execute_psql,
            mock.patch.object(SEEDER, "_unlink_token_file") as unlink_tokens,
        ):
            with self.assertRaises(SEEDER.FixtureSeedError):
                SEEDER.seed_fixture(
                    "reader-dev-test.service",
                    FIXTURE_ID,
                    "/private/new-token-output",
                    expected_target_fingerprint=TARGET_FINGERPRINT,
                )
        write_tokens.assert_called_once()
        self.assertEqual(execute_psql.call_count, 2)
        self.assertIn("candidate_count=0", execute_psql.call_args_list[1].args[1])
        self.assertIn("IF true AND", execute_psql.call_args_list[1].args[1])
        unlink_tokens.assert_called_once_with("/private/new-token-output")

    def test_cleanup_failure_after_commit_still_unlinks_tokens_and_fails_safely(self):
        environment = SEEDER.ServiceEnvironment(
            token_hmac_key=TEST_KEY,
            database=SEEDER.DatabaseTarget(
                name="reader_sync_rust_test_capacity",
                port=5432,
            ),
            target_fingerprint=TARGET_FINGERPRINT,
        )
        identities = SEEDER.build_identities(FIXTURE_ID, TEST_KEY)
        rows = SEEDER.build_seed_rows(identities, TEST_KEY, deterministic_tokens())
        with (
            mock.patch.object(
                SEEDER,
                "read_running_service_environment",
                return_value=environment,
            ),
            mock.patch.object(SEEDER, "build_identities", return_value=identities),
            mock.patch.object(SEEDER, "build_seed_rows", return_value=rows),
            mock.patch.object(SEEDER, "_write_token_file"),
            mock.patch.object(
                SEEDER,
                "_execute_psql",
                side_effect=[b"invalid-report\n", SEEDER.FixtureSeedError("safe")],
            ) as execute_psql,
            mock.patch.object(SEEDER, "_unlink_token_file") as unlink_tokens,
        ):
            with self.assertRaises(SEEDER.FixtureSeedError):
                SEEDER.seed_fixture(
                    "reader-dev-test.service",
                    FIXTURE_ID,
                    "/private/new-token-output",
                    expected_target_fingerprint=TARGET_FINGERPRINT,
                )
        self.assertEqual(execute_psql.call_count, 2)
        unlink_tokens.assert_called_once_with("/private/new-token-output")


class AggregateReportTests(unittest.TestCase):
    def test_seed_report_allows_only_expected_aggregate_values(self):
        report = {key: SEEDER.ACCOUNT_COUNT for key in SEEDER.SEED_REPORT_KEYS}
        report["ok"] = True
        report["disabledAccountCount"] = 0
        report["tokenFileMode"] = 0o600
        self.assertEqual(SEEDER.validate_seed_report(report), report)

    def test_report_rejects_unknown_or_string_fields(self):
        report = {key: SEEDER.ACCOUNT_COUNT for key in SEEDER.SEED_REPORT_KEYS}
        report["ok"] = True
        report["disabledAccountCount"] = 0
        report["tokenFileMode"] = 0o600
        report["path"] = "/private/should-never-appear"
        with self.assertRaises(SEEDER.FixtureSeedError):
            SEEDER.validate_seed_report(report)
        report.pop("path")
        report["sessionCount"] = "2048"
        with self.assertRaises(SEEDER.FixtureSeedError):
            SEEDER.validate_seed_report(report)

    def test_psql_report_parser_rejects_extra_output(self):
        with self.assertRaises(SEEDER.FixtureSeedError):
            SEEDER._parse_psql_report(b'{"ok":true}\nsecond-line\n')


if __name__ == "__main__":
    unittest.main()
