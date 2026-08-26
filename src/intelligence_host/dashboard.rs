//! Loopback-only observability page for the dedicated local intelligence host.
//!
//! This is intentionally owned by `kunpeng-intelligence-host`, not the reader
//! client.  It exposes only aggregate queue/audit state, explicit operator
//! actions and one-time local worker pairing. It never binds a LAN address,
//! serves saved article text/source URLs, or exposes model prompts/reasoning.

use super::audit;
use super::{
    continuous_processing_active, initialize_configuration, read_configuration, run_once,
    start_continuous_processing, status, stop_continuous_processing, HostStatus, RunReport,
};
use crate::intelligence_worker_lifecycle::{
    self, IntelligenceWorkerCredentialRevokeRequest, IntelligenceWorkerPairingRequest,
};
use serde::Deserialize;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

const DEFAULT_PORT: u16 = 38_421;
const MAX_REQUEST_BYTES: usize = 16 * 1024;
const DASHBOARD_HEADER: &str = "x-kunpeng-host-dashboard";
const HTML: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/apps/intelligence-host/dashboard.html"
));
const CSS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/apps/intelligence-host/dashboard.css"
));
const JAVASCRIPT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/apps/intelligence-host/dashboard.js"
));

#[derive(Default)]
struct DashboardRuntime {
    running: AtomicBool,
    last_run: Mutex<Option<RunReport>>,
    last_error: Mutex<Option<String>>,
}

#[derive(Debug, PartialEq, Eq)]
struct Request {
    method: String,
    path: String,
    dashboard_header: bool,
    body: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DashboardPairingRequest {
    base_url: String,
    publish_credential: String,
    relay_credential: String,
    #[serde(default)]
    launch_at_login: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DashboardContinuousRequest {
    #[serde(default)]
    launch_at_login: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DashboardAuditArticleRequest {
    handle: String,
}

pub(super) const fn default_port() -> u16 {
    DEFAULT_PORT
}

pub(super) fn serve(port: u16) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|_| format!("无法监听本机情报工作台端口 {port}"))?;
    let address = listener
        .local_addr()
        .map_err(|_| "无法读取本机情报工作台监听地址".to_string())?;
    let runtime = Arc::new(DashboardRuntime::default());
    println!(
        "{}",
        serde_json::json!({
            "kind": "kunpeng-intelligence-host-dashboard",
            "url": format!("http://{address}"),
            "loopbackOnly": true,
        })
    );
    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let runtime = Arc::clone(&runtime);
                std::thread::spawn(move || {
                    let _ = handle_connection(stream, runtime);
                });
            }
            Err(_) => continue,
        }
    }
    Ok(())
}

fn handle_connection(mut stream: TcpStream, runtime: Arc<DashboardRuntime>) -> Result<(), ()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let request = read_request(&mut stream)?;
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") => write_response(
            &mut stream,
            200,
            "text/html; charset=utf-8",
            HTML.as_bytes(),
        ),
        ("GET", "/assets/dashboard.css") => {
            write_response(&mut stream, 200, "text/css; charset=utf-8", CSS.as_bytes())
        }
        ("GET", "/assets/dashboard.js") => write_response(
            &mut stream,
            200,
            "text/javascript; charset=utf-8",
            JAVASCRIPT.as_bytes(),
        ),
        ("GET", "/api/status") => write_status(&mut stream, &runtime),
        ("GET", "/api/distribution-status") => write_distribution_status(&mut stream),
        ("POST", "/api/audit/articles") if request.dashboard_header => {
            write_audit_articles(&mut stream)
        }
        ("POST", "/api/audit/article") if request.dashboard_header => {
            write_audit_article(&mut stream, &request.body)
        }
        ("POST", "/api/initialize") if request.dashboard_header => {
            match initialize_configuration() {
                Ok(_) => write_json(&mut stream, 200, serde_json::json!({"initialized": true})),
                Err(_) => write_json(
                    &mut stream,
                    500,
                    serde_json::json!({"error": "无法初始化本机情报主机配置"}),
                ),
            }
        }
        ("POST", "/api/run-once") if request.dashboard_header => start_round(&mut stream, runtime),
        ("POST", "/api/continuous-start") if request.dashboard_header => {
            start_continuous(&mut stream, &runtime, &request.body)
        }
        ("POST", "/api/continuous-stop") if request.dashboard_header => {
            stop_continuous(&mut stream)
        }
        ("POST", "/api/distribution-pair") if request.dashboard_header => {
            pair_distribution_worker(&mut stream, &request.body)
        }
        ("POST", "/api/distribution-revoke") if request.dashboard_header => {
            revoke_distribution_worker(&mut stream)
        }
        ("POST", _) => write_json(
            &mut stream,
            403,
            serde_json::json!({"error": "本机页面校验失败"}),
        ),
        _ => write_response(
            &mut stream,
            404,
            "text/plain; charset=utf-8",
            "未找到本机工作台页面".as_bytes(),
        ),
    }
    .map_err(|_| ())
}

fn write_audit_articles(stream: &mut TcpStream) -> std::io::Result<()> {
    match audit::list_articles() {
        Ok(items) => write_json(
            stream,
            200,
            serde_json::to_value(items).unwrap_or_else(|_| serde_json::json!({"items": []})),
        ),
        Err(_) => write_json(
            stream,
            500,
            serde_json::json!({"error": "无法读取本机新闻处理明细"}),
        ),
    }
}

fn write_audit_article(stream: &mut TcpStream, body: &[u8]) -> std::io::Result<()> {
    let request: DashboardAuditArticleRequest = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(_) => {
            return write_json(
                stream,
                400,
                serde_json::json!({"error": "新闻审计引用无效"}),
            )
        }
    };
    match audit::article_detail(&request.handle) {
        Ok(item) => write_json(
            stream,
            200,
            serde_json::to_value(item)
                .unwrap_or_else(|_| serde_json::json!({"error": "无法显示新闻处理明细"})),
        ),
        Err(_) => write_json(
            stream,
            404,
            serde_json::json!({"error": "新闻审计记录不可用"}),
        ),
    }
}

fn write_distribution_status(stream: &mut TcpStream) -> std::io::Result<()> {
    match intelligence_worker_lifecycle::lifecycle_status() {
        Ok(status) => write_json(
            stream,
            200,
            serde_json::to_value(status).unwrap_or_else(|_| serde_json::json!({"paired": false})),
        ),
        Err(_) => write_json(
            stream,
            500,
            serde_json::json!({"error": "无法读取本机分发配置"}),
        ),
    }
}

fn pair_distribution_worker(stream: &mut TcpStream, body: &[u8]) -> std::io::Result<()> {
    let request: DashboardPairingRequest = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(_) => {
            return write_json(
                stream,
                400,
                serde_json::json!({"error": "配对输入格式无效"}),
            )
        }
    };
    // The request is deliberately moved into the native lifecycle boundary.
    // No caller, log line or JSON response ever receives its input again.
    let result = intelligence_worker_lifecycle::pair_intelligence_worker_for_local_operator(
        IntelligenceWorkerPairingRequest {
            base_url: request.base_url,
            publish_credential: request.publish_credential,
            relay_credential: request.relay_credential,
            launch_at_login: request.launch_at_login,
        },
    );
    match result {
        Ok(status) => write_json(
            stream,
            200,
            serde_json::to_value(status).unwrap_or_else(|_| serde_json::json!({"paired": true})),
        ),
        Err(_) => write_json(
            stream,
            400,
            serde_json::json!({"error": "本机分发配对未完成"}),
        ),
    }
}

fn revoke_distribution_worker(stream: &mut TcpStream) -> std::io::Result<()> {
    match intelligence_worker_lifecycle::revoke_intelligence_worker_credential(
        IntelligenceWorkerCredentialRevokeRequest {
            capability: "all".into(),
        },
    ) {
        Ok(status) => write_json(
            stream,
            200,
            serde_json::to_value(status).unwrap_or_else(|_| serde_json::json!({"paired": false})),
        ),
        Err(_) => write_json(
            stream,
            500,
            serde_json::json!({"error": "无法撤销本机分发配置"}),
        ),
    }
}

fn start_round(stream: &mut TcpStream, runtime: Arc<DashboardRuntime>) -> std::io::Result<()> {
    if continuous_processing_active() {
        return write_json(
            stream,
            409,
            serde_json::json!({"error": "本机情报持续处理正在运行；请先停止后再执行手动一轮"}),
        );
    }
    if runtime.running.swap(true, Ordering::AcqRel) {
        return write_json(
            stream,
            409,
            serde_json::json!({"error": "已有一轮本机处理正在运行"}),
        );
    }
    std::thread::spawn(move || {
        let result = read_configuration().and_then(|configuration| run_once(&configuration));
        match result {
            Ok(report) => {
                if let Ok(mut last_run) = runtime.last_run.lock() {
                    *last_run = Some(report);
                }
                if let Ok(mut error) = runtime.last_error.lock() {
                    *error = None;
                }
            }
            Err(_) => {
                if let Ok(mut error) = runtime.last_error.lock() {
                    // Deliberately do not surface a raw subprocess error here:
                    // those can contain a local path or a configured endpoint.
                    *error = Some("本机一轮处理未完成；请查看本机调试日志。".into());
                }
            }
        }
        runtime.running.store(false, Ordering::Release);
    });
    write_json(stream, 202, serde_json::json!({"started": true}))
}

fn start_continuous(
    stream: &mut TcpStream,
    runtime: &DashboardRuntime,
    body: &[u8],
) -> std::io::Result<()> {
    if runtime.running.load(Ordering::Acquire) {
        return write_json(
            stream,
            409,
            serde_json::json!({"error": "当前手动处理尚未完成；请等待本轮结束后再启动持续处理"}),
        );
    }
    let request: DashboardContinuousRequest = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(_) => {
            return write_json(
                stream,
                400,
                serde_json::json!({"error": "持续处理启动参数无效"}),
            )
        }
    };
    match start_continuous_processing(request.launch_at_login) {
        Ok(()) => write_json(stream, 202, serde_json::json!({"started": true})),
        Err(_) => write_json(
            stream,
            400,
            serde_json::json!({"error": "无法启动本机情报持续处理；请先检查来源和本机配置"}),
        ),
    }
}

fn stop_continuous(stream: &mut TcpStream) -> std::io::Result<()> {
    match stop_continuous_processing() {
        Ok(()) => write_json(stream, 202, serde_json::json!({"stopping": true})),
        Err(_) => write_json(
            stream,
            500,
            serde_json::json!({"error": "无法停止本机情报持续处理"}),
        ),
    }
}

fn write_status(stream: &mut TcpStream, runtime: &DashboardRuntime) -> std::io::Result<()> {
    let configuration = match read_configuration() {
        Ok(configuration) => configuration,
        Err(_) => {
            return write_json(
                stream,
                500,
                serde_json::json!({"error": "无法读取本机情报主机配置"}),
            );
        }
    };
    let last_run = runtime.last_run.lock().ok().and_then(|value| value.clone());
    let mut projection: HostStatus = status(
        &configuration,
        last_run,
        runtime.running.load(Ordering::Acquire),
    );
    let runtime_error = runtime
        .last_error
        .lock()
        .ok()
        .and_then(|value| value.clone());
    if runtime_error.is_some() {
        projection.last_error = runtime_error;
    }
    write_json(
        stream,
        200,
        serde_json::to_value(projection)
            .unwrap_or_else(|_| serde_json::json!({"error": "无法序列化本机状态"})),
    )
}

fn read_request(stream: &mut TcpStream) -> Result<Request, ()> {
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    while bytes.len() < MAX_REQUEST_BYTES {
        let count = stream.read(&mut chunk).map_err(|_| ())?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let header_end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
        .ok_or(())?;
    let content_length = content_length(&bytes[..header_end])?;
    let total = header_end.checked_add(content_length).ok_or(())?;
    if total > MAX_REQUEST_BYTES {
        return Err(());
    }
    while bytes.len() < total {
        let count = stream.read(&mut chunk).map_err(|_| ())?;
        if count == 0 {
            return Err(());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    parse_request(&bytes[..total])
}

fn parse_request(bytes: &[u8]) -> Result<Request, ()> {
    let header_end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
        .ok_or(())?;
    let head = std::str::from_utf8(&bytes[..header_end]).map_err(|_| ())?;
    let mut lines = head.split("\r\n");
    let request_line = lines.next().ok_or(())?;
    let mut segments = request_line.split_ascii_whitespace();
    let method = segments.next().ok_or(())?;
    let path = segments.next().ok_or(())?;
    if segments.next().is_none()
        || !matches!(method, "GET" | "POST")
        || !path.starts_with('/')
        || path.contains('?')
        || path.contains("..")
    {
        return Err(());
    }
    let dashboard_header = lines.any(|line| {
        let mut value = line.splitn(2, ':');
        value
            .next()
            .is_some_and(|name| name.trim().eq_ignore_ascii_case(DASHBOARD_HEADER))
            && value.next().is_some_and(|value| value.trim() == "1")
    });
    Ok(Request {
        method: method.into(),
        path: path.into(),
        dashboard_header,
        body: bytes[header_end..].to_vec(),
    })
}

fn content_length(header: &[u8]) -> Result<usize, ()> {
    let header = std::str::from_utf8(header).map_err(|_| ())?;
    let mut length = None;
    for line in header.split("\r\n").skip(1) {
        let mut value = line.splitn(2, ':');
        if value
            .next()
            .is_some_and(|name| name.trim().eq_ignore_ascii_case("content-length"))
        {
            let value = value
                .next()
                .ok_or(())?
                .trim()
                .parse::<usize>()
                .map_err(|_| ())?;
            if length.replace(value).is_some() {
                return Err(());
            }
        }
    }
    Ok(length.unwrap_or(0))
}

fn write_json(
    stream: &mut TcpStream,
    status: u16,
    value: serde_json::Value,
) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec());
    write_response(stream, status, "application/json; charset=utf-8", &bytes)
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        _ => "Internal Server Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'\r\nConnection: close\r\n\r\n",
        body.len(),
    )?;
    stream.write_all(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_assets_are_local_and_do_not_load_network_content() {
        assert!(HTML.contains("/assets/dashboard.css"));
        assert!(HTML.contains("/assets/dashboard.js"));
        assert!(!HTML.contains(concat!("src=\"http", "://")));
        assert!(!HTML.contains("src=\"https://"));
        assert!(!CSS.contains("url("));
        assert!(!JAVASCRIPT.contains("http://"));
        assert!(!JAVASCRIPT.contains("https://"));
    }

    #[test]
    fn dashboard_request_parser_allows_only_small_local_routes() {
        let request = parse_request(b"POST /api/run-once HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Kunpeng-Host-Dashboard: 1\r\n\r\n").unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/api/run-once");
        assert!(request.dashboard_header);
        assert!(request.body.is_empty());
        assert_eq!(default_port(), 38_421);
    }

    #[test]
    fn dashboard_accepts_only_explicit_continuous_control_routes() {
        let request = parse_request(b"POST /api/continuous-start HTTP/1.1\r\nContent-Length: 22\r\nX-Kunpeng-Host-Dashboard: 1\r\n\r\n{\"launchAtLogin\":true}").unwrap();
        assert_eq!(request.path, "/api/continuous-start");
        let decoded: DashboardContinuousRequest = serde_json::from_slice(&request.body).unwrap();
        assert!(decoded.launch_at_login);
        assert!(serde_json::from_slice::<DashboardContinuousRequest>(
            br#"{"launchAtLogin":false,"unexpected":true}"#,
        )
        .is_err());
        assert!(parse_request(
            b"POST /api/continuous-stop?force=1 HTTP/1.1\r\nX-Kunpeng-Host-Dashboard: 1\r\n\r\n"
        )
        .is_err());
    }

    #[test]
    fn dashboard_request_parser_retains_only_declared_small_json_body() {
        let request = parse_request(b"POST /api/distribution-pair HTTP/1.1\r\nContent-Length: 2\r\nX-Kunpeng-Host-Dashboard: 1\r\n\r\n{}").unwrap();
        assert_eq!(request.path, "/api/distribution-pair");
        assert_eq!(request.body, b"{}");
        assert_eq!(
            content_length(b"GET / HTTP/1.1\r\nContent-Length: 2\r\n\r\n").unwrap(),
            2
        );
        assert!(content_length(b"GET / HTTP/1.1\r\nContent-Length: no\r\n\r\n").is_err());
    }

    #[test]
    fn dashboard_request_parser_rejects_queries_and_traversal() {
        assert!(parse_request(b"GET /api/status?details=1 HTTP/1.1\r\n\r\n").is_err());
        assert!(parse_request(b"GET /../secret HTTP/1.1\r\n\r\n").is_err());
        assert!(parse_request(b"PUT /api/status HTTP/1.1\r\n\r\n").is_err());
    }
}
