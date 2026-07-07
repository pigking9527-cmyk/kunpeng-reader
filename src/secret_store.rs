use base64::{engine::general_purpose::STANDARD, Engine as _};

const DPAPI_PREFIX: &str = "dpapi:";

pub(crate) fn protect_secret(secret: &str) -> Result<String, String> {
    if secret.is_empty() {
        return Ok(String::new());
    }
    protect_bytes(secret.as_bytes())
        .map(|bytes| format!("{DPAPI_PREFIX}{}", STANDARD.encode(bytes)))
}

pub(crate) fn unprotect_secret(stored: &str) -> Result<String, String> {
    if stored.is_empty() {
        return Ok(String::new());
    }
    let Some(encoded) = stored.strip_prefix(DPAPI_PREFIX) else {
        // Backward compatibility for tokens saved before DPAPI storage existed.
        return Ok(stored.to_string());
    };
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|e| format!("凭据解码失败：{e}"))?;
    let plain = unprotect_bytes(&bytes)?;
    String::from_utf8(plain).map_err(|e| format!("凭据不是有效 UTF-8：{e}"))
}

#[cfg(windows)]
fn protect_bytes(input: &[u8]) -> Result<Vec<u8>, String> {
    win_dpapi(input, true)
}

#[cfg(windows)]
fn unprotect_bytes(input: &[u8]) -> Result<Vec<u8>, String> {
    win_dpapi(input, false)
}

#[cfg(windows)]
fn win_dpapi(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "Crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *mut DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *mut DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            p_data_in: *mut DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *mut DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "Kernel32")]
    extern "system" {
        fn LocalFree(hmem: *mut c_void) -> *mut c_void;
    }

    if input.len() > u32::MAX as usize {
        return Err("凭据过大，无法保护".into());
    }
    let mut in_blob = DataBlob {
        cb_data: input.len() as u32,
        pb_data: input.as_ptr() as *mut u8,
    };
    let mut out_blob = DataBlob {
        cb_data: 0,
        pb_data: null_mut(),
    };
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &mut in_blob,
                null(),
                null_mut(),
                null_mut(),
                null_mut(),
                0,
                &mut out_blob,
            )
        } else {
            CryptUnprotectData(
                &mut in_blob,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                0,
                &mut out_blob,
            )
        }
    };
    if ok == 0 {
        return Err("Windows 凭据保护失败".into());
    }
    let out = unsafe {
        let slice = std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize);
        let copy = slice.to_vec();
        LocalFree(out_blob.pb_data as *mut c_void);
        copy
    };
    Ok(out)
}

#[cfg(not(windows))]
fn protect_bytes(input: &[u8]) -> Result<Vec<u8>, String> {
    Ok(input.to_vec())
}

#[cfg(not(windows))]
fn unprotect_bytes(input: &[u8]) -> Result<Vec<u8>, String> {
    Ok(input.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_roundtrip_keeps_legacy_plaintext_readable() {
        assert_eq!(unprotect_secret("legacy-token").unwrap(), "legacy-token");
        let protected = protect_secret("new-token").unwrap();
        assert!(protected.starts_with(DPAPI_PREFIX));
        assert_ne!(protected, "new-token");
        assert_eq!(unprotect_secret(&protected).unwrap(), "new-token");
    }
}
