# LibreChat 生产级部署 SOP — BMW 内网

## 架构概览

```
                      Docker 容器
                    ┌───────────────────────────────────┐
用户 / 内网 ──►  Nginx (:80)  ──►  api (:3080)          │
                                      │                 │
                                      ├── host.docker.internal:8090  ──► session_keeper (宿主机) ──► BMW SSO
                                      ├── host.docker.internal:27017 ──► MongoDB (宿主机, 完整版)
                                      ├── Beacon LLM (内网 API)
                                      └── Confluence MCP (内网)
                                      │                 │
                                      ├── 持久化: images/ uploads/ logs/ skill/ plugin/ data/
                    └───────────────────────────────────┘
```

> **MongoDB 不跑容器** — 直接用宿主机已有的完整版 MongoDB。容器通过 `host.docker.internal` 连接。

---

## 前置准备

### 1. MongoDB 绑定地址检查（关键！）

你的 MongoDB 当前只监听 `127.0.0.1:27017`，容器内无法访问。
需要改为监听 `0.0.0.0`，让 Docker 网络能连进来。

**找到 MongoDB 配置文件**（通常在）：
```
C:\Program Files\MongoDB\Server\8.0\bin\mongod.cfg
```

**修改 `net.bindIp`**：
```yaml
net:
  port: 27017
  bindIp: 0.0.0.0   # 原来是 127.0.0.1
```

**重启 MongoDB 服务**：
```powershell
# 以管理员身份运行 PowerShell
Restart-Service MongoDB
```

**验证**：
```bash
netstat -ano | grep 27017
# 应看到 0.0.0.0:27017 LISTENING，而不是 127.0.0.1:27017
```

### 2. 在 `.env` 中确认配置

确保 `.env` 文件中：

```env
# MongoDB 连接（容器会用这个值，通过 host.docker.internal 连宿主机）
MONGO_URI=mongodb://host.docker.internal:27017/LibreChat

# 域名去掉端口（Nginx 在 80 端口了）
DOMAIN_CLIENT=http://10.165.22.10
DOMAIN_SERVER=http://10.165.22.10

# BMW SSO
BMW_SSO_ENABLED=true
SESSION_KEEPER_URL=http://host.docker.internal:8090
BMW_SSO_TOOL_KEY=<your_key>
```

> **注意**：`DOMAIN_CLIENT` 和 `DOMAIN_SERVER` 需从 `http://10.165.22.10:3080` 改为 `http://10.165.22.10`（去掉端口），因为 Nginx 在 80 端口接收请求。

### 3. 确保 session_keeper 在宿主机运行

session_keeper 是 BMW SSO 的认证服务，运行在宿主机的 8090 端口。
容器通过 `host.docker.internal:8090` 访问它。

---

## 部署

### 首次部署

```bash
# 1. 修改 MongoDB bindIp（见上方步骤 1）
# 2. 更新 .env（见上方步骤 2）
# 3. 构建并启动
bash deploy/deploy.sh

# 4. 检查状态
bash deploy/deploy.sh --status
```

### 日常操作

```bash
# 拉取最新代码并重新部署
bash deploy/deploy.sh --pull

# 仅重启（不重新构建，用于配置变更后）
bash deploy/deploy.sh --restart

# 停止所有容器
bash deploy/deploy.sh --down

# 查看实时日志
bash deploy/deploy.sh --logs
bash deploy/deploy.sh --logs api
bash deploy/deploy.sh --logs nginx
```

### 按需启动搜索 / RAG

```bash
# 启动 Meilisearch 搜索
docker compose -f docker-compose.prod.yml --profile search up -d

# 启动 RAG API（向量搜索）
docker compose -f docker-compose.prod.yml --profile rag up -d
```

---

## 数据备份与恢复

MongoDB 在宿主机运行，备份用本机的 `mongodump` 直接连 `127.0.0.1`。

### 手动备份

```bash
bash deploy/backup.sh
```

### 列出备份

```bash
bash deploy/backup.sh --list
```

### 从备份恢复

```bash
bash deploy/backup.sh --restore backups/librechat_20260907_143000.tar.gz
```

### 清理旧备份

```bash
# 保留最近 7 天
bash deploy/backup.sh --prune 7
```

### 定时备份（Windows Task Scheduler）

1. 打开 Task Scheduler → Create Basic Task
2. 名称：`LibreChat Backup`，每天 02:00 触发
3. 操作：Start a program
   - Program: `C:\Program Files\Git\bin\bash.exe`
   - Arguments: `-c "cd /c/Users/q446328/Desktop/LibreChat && bash deploy/backup.sh"`
4. Start in: `C:\Users\q446328\Desktop\LibreChat`

---

## 升级流程

### 升级 LibreChat 代码

```bash
# 1. 备份当前数据
bash deploy/backup.sh

# 2. 拉取最新代码并重新构建
bash deploy/deploy.sh --pull

# 3. 验证
bash deploy/deploy.sh --status
curl http://localhost/health
```

### 回滚

```bash
# 1. 回退代码
git log --oneline -10        # 找到上一个稳定版本
git checkout <commit>

# 2. 重新构建
bash deploy/deploy.sh

# 3. 如需恢复数据
bash deploy/backup.sh --restore backups/librechat_<timestamp>.tar.gz
```

---

## 监控

### 健康检查

```bash
# API 健康检查
curl http://localhost/health

# 容器状态
docker compose -f docker-compose.prod.yml ps

# 容器资源使用
docker stats librechat-api librechat-nginx
```

### 日志

```bash
# 所有服务日志
docker compose -f docker-compose.prod.yml logs -f --tail=100

# 特定服务
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml logs -f nginx
```

### MongoDB（宿主机直接操作）

```bash
# 连接 MongoDB shell
mongosh "mongodb://127.0.0.1:27017/LibreChat"

# 检查数据库大小
mongosh --eval "db.stats()"
```

---

## 文件结构

```
LibreChat/
├── .env                          # 环境变量
├── librechat.yaml                # LibreChat 配置
├── Dockerfile.prod               # 生产级多阶段构建
├── docker-compose.prod.yml       # 生产级 Compose 编排（无 MongoDB 容器）
├── deploy/
│   ├── nginx.conf                # Nginx 反向代理配置
│   ├── deploy.sh                 # 部署/重启/状态脚本
│   ├── backup.sh                 # MongoDB 备份/恢复脚本（连宿主机）
│   └── README.deploy.md          # 本文档
├── backups/                      # MongoDB 备份（自动生成）
├── images/                       # 用户上传图片（持久化）
├── uploads/                      # 文件上传（持久化）
├── logs/                         # 应用日志（持久化）
├── skill/                        # LibreChat skills
└── plugin/                       # LibreChat plugins
```

---

## 常见问题

### Q: 容器启动后 API 报 MongoDB 连接失败？

1. 确认 MongoDB 监听 `0.0.0.0:27017`（不是 `127.0.0.1`）
   ```bash
   netstat -ano | grep 27017
   ```
2. 从容器内测试连通性：
   ```bash
   docker exec librechat-api curl -s http://host.docker.internal:27017
   ```
3. 确认 `.env` 中 `MONGO_URI=mongodb://host.docker.internal:27017/LibreChat`

### Q: BMW SSO 登录失败？

1. 确认 session_keeper 在宿主机 8090 端口运行
2. 测试容器到宿主机连通性：
   ```bash
   docker exec librechat-api curl -s http://host.docker.internal:8090
   ```
3. 检查 `.env` 中 `BMW_SSO_ENABLED=true` 和 `SESSION_KEEPER_URL`

### Q: 需要修改端口？

Nginx 监听 80 端口。如需改 Nginx 端口，编辑 `deploy/nginx.conf` 的 `listen` 指令和 `docker-compose.prod.yml` 中 nginx 服务的 `ports`。

### Q: 80 端口被占用？

```bash
# 查看谁占用了 80
netstat -ano | grep ':80 '

# 如果是其他服务（如 IIS），可以改用 3080 对外
# 编辑 docker-compose.prod.yml:
#   ports:
#     - "3080:80"
# 同时更新 .env 中 DOMAIN_CLIENT/SERVER 为 http://10.165.22.10:3080
```
