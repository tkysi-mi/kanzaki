const crypto = require('crypto');
const http = require('http');

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const { verifier, challenge } = generatePKCE();
const clientId = 'kanzaki-cli'; // ダミー
const redirectUri = 'http://127.0.0.1:1455/auth/callback';

const authUrl = `https://auth.openai.com/oauth/authorize?response_type=code&client_id=${clientId}&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${redirectUri}&scope=openai.public`;

console.log("Open this URL in your browser:");
console.log(authUrl);

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/auth/callback')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const code = url.searchParams.get('code');
    res.end('<h1>Success! You can close this tab.</h1>');
    console.log('Received code:', code);
    server.close();
    
    // 交換テスト
    fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        grant_type: 'authorization_code',
        code: code,
        code_verifier: verifier,
        redirect_uri: redirectUri
      })
    }).then(r => r.json()).then(data => {
      console.log('Token response:', data);
    }).catch(e => console.error(e));
  }
});

server.listen(1455, () => {
  console.log("Listening on 1455...");
});
