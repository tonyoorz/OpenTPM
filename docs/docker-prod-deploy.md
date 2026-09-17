# LibreChat 生产级 Docker 部署 — BMW 内网

## 架构总览

```
                    ┌─────────────────────────────────────────┐
                    │         docker-compose.prod.yml          │
                    │                                         │
   内网用户 ──►     │  librechat-api (3080)                   │
   10.165.22.10     │    ├─ BMW SSO → host.docker.internal:8090│
                    │    ├─ Beacon LLM → beaconapi.bmwbrill.cn │
                    │    ├─ Confluence MCP → atc.bmwgroup.net │
                    │    └─ librechat.yaml (配置)              │
                    │                                         │
                    │  librechat-mongodb (27017)               │
                    │    └─ WiredTiger, auth, PVC 持久化       │
                    │                                         │
                    │  [按需] meilisearch / vectordb / rag_api  │
                    └─────────────────────────────────────────┘
```

### 与裸机部署的区别

| 项目 | 裸机（当前） | 容器化（本方案） |
|------|-------------|-----------------|
| MongoDB | 便携版，手动 `mongod` | 容器，`restart: always`，auth + init 脚本 |
| 后端 | `npm run backend`，手动重启 | 容器，`HEALTHCHECK` 自动探活 |
| 崩溃恢复 | 无人看管，服务中断 | 自动重启，健康检查失败即重启 |
| 部署 | 拉代码、build、重启脚本 | `docker compose build && up -d` |
| 隔离 | 与其他进程争资源 | `deploy.resources` 内存限额 |
| 持久化 | 散落在宿主机目录 | Named volumes，统一管理 |

---

## 文件清单

| 文件 | 用途 |
|------|------|
| `Dockerfile.prod` | 多阶段构建镜像，包含 BMW SSO / plugin / skill |
| `docker-compose.prod.yml` | 编排: api + mongodb + 按需 search/rag |
| `mongo-init.js` | MongoDB 首次启动时自动创建低权限 app 用户 |
| `.env.prod.example` | 环境变量模板，含所有必填项说明 |

---

## 部署步骤

### 1. 准备环境变量

```bash
cp .env.prod.example .env
```

编辑 `.env`，填入所有标注 `❰必填❱` 的值。生成密钥:

```bash
# JWT_SECRET
openssl rand -hex 48
# CREDS_KEY / CREDS_IV / SESSION_SECRET / MONGO 密码
openssl rand -hex 32
```

从你现有的 `.env` 里拷过来:
- `BEACON_API_KEY` / `BEACON_PERSONAL_API_KEY`
- `CONFLUENCE_TOKEN`
- `BMW_SSO_TOOL_KEY`

### 2. 构建 & 启动

```bash
# 构建镜像（首次约 10-15 分钟，主要是 npm ci + 前端 build）
docker compose -f docker-compose.prod.yml build

# 启动（后台运行）
docker compose -f docker-compose.prod.yml up -d
```

### 3. 验证

```bash
# 查看容器状态
docker compose -f docker-compose.prod.yml ps

# 查看后端日志
docker compose -f docker-compose.prod.yml logs -f api

# 健康检查
curl http://localhost:3080/health

# MongoDB 连接验证
docker compose -f docker-compose.prod.yml exec mongodb \
  mongosh --eval "db.adminCommand('ping')" \
  --username librechat --password ❰你的密码❱
```

浏览器访问 `http://10.165.22.10:3080`，应看到 BMW SSO 登录页面。

---

## 关键配置说明

### MongoDB 连接串

```
MONGO_URI=mongodb://librechat_app:❰密码❱@mongodb:27017/LibreChat?authSource=LibreChat
```

- `librechat_app` 是 `mongo-init.js` 自动创建的低权限用户（仅 `readWrite`）
- `mongodb` 是 compose 内的服务名（容器间 DNS 解析）
- `authSource=LibreChat` 因为 app 用户创建在 `LibreChat` 库下
- **不要**用 root 用户连接应用

### session_keeper 地址

你的 BMW SSO 依赖 `session_keeper` 服务。两种方式:

| 方式 | SESSION_KEEPER_URL | 适用场景 |
|------|-------------------|---------|
| 宿主机 | `http://host.docker.internal:8090` | session_keeper 跑在宿主机上（当前方案） |
| 容器内 | `http://session_keeper:8090` | session_keeper 也容器化（需在 compose 里加服务） |

当前 `.env.prod.example` 默认用 `host.docker.internal`，因为 `docker-compose.prod.yml` 里已配置 `extra_hosts`。

### librechat.yaml

`librechat.yaml` 通过只读 bind mount 挂入容器 (`/app/librechat.yaml:ro`)。
修改后重启 api 容器即可:

```bash
docker compose -f docker-compose.prod.yml restart api
```

---

## 按需启动搜索 / RAG

默认不启动 Meilisearch 和 RAG（因为 `.env` 里 `SEARCH=false`）。

启用搜索:

```bash
# .env 中设置
SEARCH=true
MEILI_MASTER_KEY=❰openssl rand -hex 32❱

# 启动（加 --profile search）
docker compose -f docker-compose.prod.yml --profile search up -d
```

启用 RAG:

```bash
# .env 中设置 PG_PASSWORD 等
docker compose -f docker-compose.prod.yml --profile rag up -d
```

---

## 日常运维

### 更新代码

```bash
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d   # 滚动重启
```

### 查看日志

```bash
# 实时日志
docker compose -f docker-compose.prod.yml logs -f api

# 最近 100 行
docker compose -f docker-compose.prod.yml logs --tail 100 api

# MongoDB 日志
docker compose -f docker-compose.prod.yml logs mongodb
```

### 备份 MongoDB

```bash
docker compose -f docker-compose.prod.yml exec mongodb \
  mongodump --uri="mongodb://librechat_app:❰密码❱@localhost:27017/LibreChat?authSource=LibreChat" \
  --archive --gzip > backup-$(date +%Y%m%d).gz
```

### 恢复 MongoDB

```bash
docker compose -f docker-compose.prod.yml exec -T mongodb \
  mongorestore --uri="mongodb://librechat_app:❰密码❱@localhost:27017/LibreChat?authSource=LibreChat" \
  --archive --gzip < backup-20260901.gz
```

### 查看容器资源占用

```bash
docker stats librechat-api librechat-mongodb
```

---

## 故障排查

### api 容器反复重启

```bash
# 查看退出原因
docker compose -f docker-compose.prod.yml logs api | tail -50

# 常见原因:
# 1. MONGO_URI 密码不对 → 检查 .env 中 MONGO_APP_PASSWORD 和 MONGO_URI 是否一致
# 2. session_keeper 不可达 → 确认宿主机 8090 端口的 session_keeper 在运行
# 3. .env 文件格式错误 → 不要有多余空格或引号不匹配
```

### MongoDB 健康检查失败

```bash
# 进入 mongodb 容器手动测试
docker compose -f docker-compose.prod.yml exec mongodb \
  mongosh --eval "db.adminCommand('ping')" \
  --username librechat --password ❰密码❱

# 如果是首次启动，等 20 秒让 init 脚本执行完
```

### 前端页面空白

```bash
# 确认前端构建产物存在
docker compose -f docker-compose.prod.yml exec api \
  ls -la /app/client/dist/

# 如果为空，说明构建阶段失败，重新 build
docker compose -f docker-compose.prod.yml build --no-cache api
```

---

## 下一步: 上 OCP/K8s

本方案验证通过后，可以平滑迁移到 BMW 内网的 OCP/K8s 平台:

1. 把 `librechat-bmw:latest` 镜像推到内网镜像仓库
2. MongoDB → 平台的 DBaaS 或独立 StatefulSet
3. session_keeper → 独立 Service 或继续走 `host.docker.internal` 等价配置
4. api → Deployment (replicas: 2+) + Service + Ingress（域名访问）
5. ConfigMap 挂载 `.env` + `librechat.yaml`，Secret 挂载密钥
6. PVC 替代 named volumes 持久化

届时我可以帮你出对应的 YAML。
