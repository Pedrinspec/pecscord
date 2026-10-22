# Pecscord

Chat de texto, voz, câmera e compartilhamento de tela para um grupo de amigos.
Servidor em Rust (Axum + WebSocket) e interface em TypeScript. A mídia vai direto
entre os participantes por WebRTC; o servidor só faz a sinalização e o chat.

## Requisitos

- Node.js 20+
- Rust (via rustup) e, no Windows, o Visual Studio Build Tools com a carga de C++
- Um navegador Chromium (Edge ou Chrome) para os testes automatizados

## Rodar

```
cd client
npm install
npm run build        # gera client/dist, servido pelo servidor

cd ../server
cargo run            # http://localhost:3000
```

Abra `http://localhost:3000` em duas abas, entre na mesma sala com nomes
diferentes e aceite o microfone.

Para desenvolver a interface com recarregamento automático, rode `npm run dev`
em `client` (porta 5173) com o servidor ativo; o Vite encaminha `/ws` para ele.

A porta do servidor pode ser trocada pela variável `PORT`.

## Testes

```
cd tests
npm install
npm test
```

O teste compila cliente e servidor, sobe o servidor na porta 3100 (pasta de
build própria, então pode rodar com um `cargo run` em andamento), abre duas
páginas com câmera e microfone falsos e verifica chat, voz, câmera, tela e
troca de preset.

## Produção (Docker / Railway)

O `Dockerfile` na raiz compila a interface e o servidor e gera uma imagem só
com o binário e os arquivos estáticos. O servidor lê `PORT` e `STATIC_DIR`.

```
docker build -t pecscord .
docker run -p 3000:3000 pecscord
```

No Railway, basta apontar o projeto para este repositório: ele detecta o
`Dockerfile` e fornece HTTPS. Com HTTPS, câmera, microfone e tela funcionam
para qualquer pessoa, não só em `localhost`.

## Estrutura

- `server/` — sinalização e chat (`src/main.rs`)
- `client/` — interface (`index.html`, `src/main.ts`)
- `tests/` — teste de ponta a ponta (`e2e.mjs`)

## Limitações atuais

- Câmera, microfone e tela só funcionam em `localhost` ou HTTPS.
- Só há STUN; redes com NAT restritivo podem precisar de TURN.
- Malha P2P: cada pessoa envia o próprio vídeo para todas as outras. Serve para
  grupos pequenos; para muitas pessoas seria preciso um SFU.
