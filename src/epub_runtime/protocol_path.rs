use crate::reader_protocol::percent_decode;

pub(super) fn parse_request_path(path: &str) -> Option<(String, u64, String)> {
    let decoded = percent_decode(path);
    let mut parts = decoded.trim_start_matches('/').splitn(3, '/');
    let kind = parts.next()?.to_string();
    let id = parts.next()?.parse().ok()?;
    let rest = parts.next().unwrap_or("").to_string();
    Some((kind, id, rest))
}

#[cfg(test)]
mod tests {
    use super::parse_request_path;

    #[test]
    fn parses_resource_paths_after_percent_decoding_without_changing_the_route_shape() {
        assert_eq!(
            parse_request_path("/res/42/OEBPS%2Fimages%2Fcover.jpg"),
            Some(("res".to_string(), 42, "OEBPS/images/cover.jpg".to_string()))
        );
        assert_eq!(parse_request_path("/chapter/not-a-number/1"), None);
    }
}
