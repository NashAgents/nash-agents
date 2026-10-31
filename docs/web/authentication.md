# Nash Web Control Plane: 身份认证与安全防护 (Authentication)

## 1. 认证模型与标准凭据

- **登录端点**：`POST /api/auth/login`
- **登出端点**：`POST /api/auth/logout`
- **身份核验**：`GET /api/auth/me`
- **默认管理员凭据**：
  - 用户名：`admin` (可通过环境变量 `DASHBOARD_USER` 自定义)
  - 密码：必须通过环境变量 `DASHBOARD_PASS` 或 `ADMIN_PASS` 设置；未配置时登录接口返回 503

---

## 2. 安全防线实现细节

### 2.1 防计时攻击 (Timing-Safe Comparison)
为彻底杜绝密码比对阶段被黑客通过微秒级响应差异嗅探密码长度与前缀，服务端必须使用 Node.js 原生安全比对函数：
```typescript
const isUserValid = userBuffer.length === expectedUserBuffer.length &&
  crypto.timingSafeEqual(userBuffer, expectedUserBuffer);

const isPassValid = passBuffer.length === expectedPassBuffer.length &&
  crypto.timingSafeEqual(passBuffer, expectedPassBuffer);
```

### 2.2 HttpOnly Session Cookie 防 XSS 窃取
- 登录成功后，服务端下发名为 `nash_session` 的 Cookie：
  ```http
  Set-Cookie: nash_session=sess-[random64]; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure
  ```
- **关键属性**：
  - `HttpOnly`：前端 JavaScript 脚本无权读取该 Cookie，彻底免疫 XSS 攻击窃取 Token。
  - `SameSite=Lax`：有效防御绝大多数第三方跨站请求伪造。
  - `Secure`：强制仅在 HTTPS 环境下传输。

### 2.3 双重防线：CSRF Token 校验
- 仅有 Cookie 仍有潜在 CSRF 风险，因此登录响应中下发一次性或会话级随机 `csrfToken`。
- 前端拦截所有具有副作用的 HTTP 动词 (`POST` / `PUT` / `PATCH` / `DELETE`)，并在请求头中附加：
  ```http
  x-csrf-token: [csrfToken]
  ```
- 服务端在执行任何写操作前强制校验该 Token；若 Token 缺失或不匹配，立即抛出 `401 Unauthorized (Invalid CSRF Token)` 拦截拒绝。

### 2.4 会话生命周期与主动销毁
- 用户点击登出时，服务端从持久库中标记注销当前 Session，并下发 `Max-Age=0` 响应头指令浏览器彻底清除本地 Cookie。
- 登出后的失效 Session 再次请求任何受保护端点一律拒绝 (401)。
