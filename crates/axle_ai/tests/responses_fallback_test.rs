use axle_ai::{CompletionOptions, LlmProvider, Message, OpenAiProvider};
use futures::StreamExt;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const CHAT_400: &str = r#"{"error":{"message":"模型 gpt-5.6-sol 不支持 /v1/chat/completions 接口，请改用 /v1/responses（OpenAI Responses API）。"}}"#;

const RESPONSES_SSE: &str = concat!(
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello from Responses\"}\n\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":7,\"output_tokens\":3}}}\n\n",
);

async fn read_request(socket: &mut TcpStream) -> (String, String) {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1_024];
    loop {
        let read = socket.read(&mut chunk).await.unwrap();
        if read == 0 {
            return (String::new(), String::new());
        }
        buffer.extend_from_slice(&chunk[..read]);
        let Some(headers_end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let headers = String::from_utf8_lossy(&buffer[..headers_end]).to_string();
        let content_length = headers.lines().find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|value| value.trim().parse::<usize>().ok())
        });
        let body_start = headers_end + 4;
        let content_length = content_length.unwrap_or(0);
        if buffer.len() < body_start + content_length {
            continue;
        }
        let path = headers
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or_default()
            .to_string();
        let body =
            String::from_utf8_lossy(&buffer[body_start..body_start + content_length]).to_string();
        return (path, body);
    }
}

async fn serve(
    listener: TcpListener,
    request_count: usize,
    requests: Arc<Mutex<Vec<(String, String)>>>,
) {
    for _ in 0..request_count {
        let (mut socket, _) = listener.accept().await.unwrap();
        let (path, body) = read_request(&mut socket).await;
        requests.lock().unwrap().push((path.clone(), body));

        let (status, content_type, payload) = if path.ends_with("/chat/completions") {
            ("400 Bad Request", "application/json", CHAT_400.to_string())
        } else {
            ("200 OK", "text/event-stream", RESPONSES_SSE.to_string())
        };
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            payload.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn retries_a_responses_only_model_on_the_responses_api_and_remembers_it() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let server = tokio::spawn(serve(listener, 3, requests.clone()));

    let provider = OpenAiProvider::new("test-key", Some(format!("http://{address}/v1")));
    let messages = vec![Message::user("hello")];
    let options = CompletionOptions {
        model: "gpt-5.6-sol".into(),
        ..CompletionOptions::default()
    };

    let mut events = Vec::new();
    let mut stream = provider.stream(&messages, &options).await.unwrap();
    while let Some(event) = stream.next().await {
        events.push(event);
    }
    assert!(events.iter().any(|event| matches!(
        event,
        axle_ai::AssistantMessageEvent::TextDelta(text) if text == "Hello from Responses"
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        axle_ai::AssistantMessageEvent::Done {
            usage: Some(usage)
        } if usage.total_tokens == 10
    )));

    let mut stream = provider.stream(&messages, &options).await.unwrap();
    while stream.next().await.is_some() {}

    server.await.unwrap();

    let requests = requests.lock().unwrap();
    let paths = requests
        .iter()
        .map(|(path, _)| path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        paths,
        vec!["/v1/chat/completions", "/v1/responses", "/v1/responses"]
    );
    let responses_body: serde_json::Value = serde_json::from_str(&requests[1].1).unwrap();
    assert_eq!(responses_body["model"], "gpt-5.6-sol");
    assert_eq!(responses_body["store"], false);
    assert_eq!(responses_body["input"][0]["role"], "user");
}
