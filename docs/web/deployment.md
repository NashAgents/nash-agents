# Web deployment

Build the runtime and web assets with `npm ci`, `npm ci --prefix apps/web`, and `npm run build:all` using the supported Node 24 release. Run `nash cluster preflight` before starting a service. Supply database and authentication values through the service environment; never place them in command-line arguments or the repository.

The coordinator should listen on `127.0.0.1:18444` behind a TLS reverse proxy. Replace `nash.example.com` and certificate paths with your own values. Set `NASH_TRUST_PROXY=1` only when that trusted proxy overwrites forwarded headers and the coordinator is not directly reachable from the network.

```nginx
server {
    listen 443 ssl;
    server_name nash.example.com;
    ssl_certificate /etc/ssl/nash/server.crt;
    ssl_certificate_key /etc/ssl/nash/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:18444;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 86400s;
    }
    location /ws/cluster {
        proxy_pass http://127.0.0.1:18444/ws/cluster;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 86400s;
    }
}
```

Preserve `$http_host`, including an explicit external port when one is used. The browser origin, Host header and forwarded scheme must agree for cookie/CSRF validation. Keep SSE response buffering disabled. Validate same-origin asset requests, authentication, WebSocket reconnection and streamed events using the real deployment URL.

The systemd examples in `templates/systemd/` use a dedicated `nash` account, `/opt/nash-agents`, `/usr/bin/node` and `/etc/nash/*.env`. Replace those paths after checking the actual Node executable and installation location. Configure secrets in a restricted environment file outside the checkout. These templates are examples, not an instruction to overwrite an existing unit or credentials.

Restart limits and `RestartPreventExitStatus=78` stop permanent configuration failures from looping. A restart is successful only after the health endpoint, release identity and sandbox capability checks pass; a running PID alone does not establish readiness.
