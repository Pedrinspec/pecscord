use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tokio::sync::{mpsc, RwLock};
use tower_http::services::ServeDir;

type PeerId = u64;

const MAX_NAME_CHARS: usize = 32;
const MAX_TEXT_CHARS: usize = 2000;

#[derive(Clone)]
struct AppState {
    rooms: Arc<RwLock<HashMap<String, HashMap<PeerId, Peer>>>>,
    next_id: Arc<AtomicU64>,
}

#[derive(Clone)]
struct Peer {
    name: String,
    tx: mpsc::UnboundedSender<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    Join { room: String, name: String },
    Chat { text: String },
    // Mensagens de sinalização WebRTC (offer, answer, ICE) são apenas repassadas.
    Signal { to: PeerId, data: serde_json::Value },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMsg {
    Joined { id: PeerId, peers: Vec<PeerInfo> },
    PeerJoined { peer: PeerInfo },
    PeerLeft { id: PeerId },
    Chat { from: PeerId, name: String, text: String },
    Signal { from: PeerId, data: serde_json::Value },
    Error { message: String },
}

#[derive(Serialize, Clone)]
struct PeerInfo {
    id: PeerId,
    name: String,
}

#[tokio::main]
async fn main() {
    let state = AppState {
        rooms: Default::default(),
        next_id: Arc::new(AtomicU64::new(1)),
    };

    // Em desenvolvimento serve client/dist ao lado; em produção (Docker) a pasta vem de STATIC_DIR.
    let static_dir = std::env::var("STATIC_DIR")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../client/dist").to_string());

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .fallback_service(ServeDir::new(static_dir))
        .with_state(state);

    // Plataformas de hospedagem (ex.: Railway) informam a porta pela variável PORT.
    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .unwrap_or_else(|e| panic!("não foi possível abrir a porta {port}: {e}"));
    println!("Pecscord rodando em http://localhost:{port}");
    axum::serve(listener, app).await.expect("erro no servidor");
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Tarefa dedicada que envia para o socket tudo que for enfileirado em `tx`.
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sender.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    let mut current_room: Option<String> = None;

    while let Some(Ok(msg)) = receiver.next().await {
        let Message::Text(text) = msg else { continue };

        let parsed: ClientMsg = match serde_json::from_str(text.as_str()) {
            Ok(m) => m,
            Err(e) => {
                send_error(&tx, &format!("mensagem inválida: {e}"));
                continue;
            }
        };

        match parsed {
            ClientMsg::Join { room, name } => {
                if current_room.is_some() {
                    send_error(&tx, "você já está em uma sala");
                    continue;
                }
                let name: String = name.trim().chars().take(MAX_NAME_CHARS).collect();
                let room = room.trim().to_string();
                if name.is_empty() || room.is_empty() {
                    send_error(&tx, "informe nome e sala");
                    continue;
                }

                let mut rooms = state.rooms.write().await;
                let members = rooms.entry(room.clone()).or_default();

                let peers: Vec<PeerInfo> = members
                    .iter()
                    .map(|(pid, p)| PeerInfo { id: *pid, name: p.name.clone() })
                    .collect();

                let joined = ServerMsg::PeerJoined {
                    peer: PeerInfo { id, name: name.clone() },
                };
                for p in members.values() {
                    send_msg(&p.tx, &joined);
                }

                members.insert(id, Peer { name, tx: tx.clone() });
                send_msg(&tx, &ServerMsg::Joined { id, peers });
                current_room = Some(room);
            }

            ClientMsg::Chat { text } => {
                let Some(room) = &current_room else {
                    send_error(&tx, "entre em uma sala primeiro");
                    continue;
                };
                let text = text.trim();
                if text.is_empty() || text.chars().count() > MAX_TEXT_CHARS {
                    continue;
                }

                let rooms = state.rooms.read().await;
                if let Some(members) = rooms.get(room) {
                    if let Some(me) = members.get(&id) {
                        let msg = ServerMsg::Chat {
                            from: id,
                            name: me.name.clone(),
                            text: text.to_string(),
                        };
                        for p in members.values() {
                            send_msg(&p.tx, &msg);
                        }
                    }
                }
            }

            ClientMsg::Signal { to, data } => {
                let Some(room) = &current_room else { continue };
                let rooms = state.rooms.read().await;
                if let Some(target) = rooms.get(room).and_then(|m| m.get(&to)) {
                    send_msg(&target.tx, &ServerMsg::Signal { from: id, data });
                }
            }
        }
    }

    // Conexão encerrada: remove o peer e avisa a sala.
    if let Some(room) = current_room {
        let mut rooms = state.rooms.write().await;
        if let Some(members) = rooms.get_mut(&room) {
            members.remove(&id);
            for p in members.values() {
                send_msg(&p.tx, &ServerMsg::PeerLeft { id });
            }
            if members.is_empty() {
                rooms.remove(&room);
            }
        }
    }
    writer.abort();
}

fn send_msg(tx: &mpsc::UnboundedSender<String>, msg: &ServerMsg) {
    if let Ok(text) = serde_json::to_string(msg) {
        let _ = tx.send(text);
    }
}

fn send_error(tx: &mpsc::UnboundedSender<String>, message: &str) {
    send_msg(tx, &ServerMsg::Error { message: message.to_string() });
}
