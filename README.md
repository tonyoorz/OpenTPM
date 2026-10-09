<p align="center">
  <a href="#">
    <img src="client/public/assets/logo.svg" height="200">
  </a>
  <h1 align="center">OpenTPM</h1>
  <p align="center">AI-Powered Test Process Management & Defect Analysis Platform</p>
</p>

---

## Overview

**OpenTPM** is an AI-driven test process management platform built on top of [LibreChat](https://github.com/danny-avila/LibreChat). It integrates large language model capabilities with automotive testing workflows — enabling intelligent defect analysis, test case generation, and quality insights through natural language interaction.

## Key Features

### Defect Intelligence
- Conversational defect querying and analysis
- Automated defect-to-test-case mapping
- Severity classification and trend analysis
- Natural language reporting for quality metrics

### Test Case Management
- AI-assisted test case generation from defect descriptions
- Batch test case creation with pattern recognition
- Test coverage gap identification
- Traceability between requirements, defects, and test cases

### AI Agent & MCP Integration
- Custom MCP (Model Context Protocol) servers for domain-specific tools
- Agent-based workflows for complex analysis tasks
- Multi-model orchestration for different analysis stages
- Extensible plugin architecture for new testing tools

### Enterprise-Ready
- SSO authentication integration
- Multi-tenant deployment support
- Private/on-premise deployment with Docker
- Configurable model endpoints (local LLM, cloud API, or hybrid)

## Getting Started

### Prerequisites

- Node.js v24+
- MongoDB 7.0+
- npm (comes with Node.js)
- Python 3.10+ (required when BMW SSO is enabled)

### Installation

```bash
# Clone the repository
git clone https://github.com/tonyoorz/OpenTPM.git
cd OpenTPM

# Install dependencies
npm run smart-reinstall

# Copy and configure environment
cp .env.example .env
# Edit .env with your configuration

# When BMW_SSO_ENABLED=true, install the BMW SSO session keeper once
cd services/session-keeper
python -m venv .venv
.venv/bin/python -m pip install -e ".[session-keeper]"

# Start the BMW SSO session keeper (port 8090)
.venv/bin/python -m session_keeper

# In another terminal, return to the repository root
cd ../..

# Start the backend (port 3080)
npm run backend:dev

# In another terminal, start the frontend (port 3090)
npm run frontend:dev
```

When `BMW_SSO_ENABLED=true`, the backend requires the session keeper at
`SESSION_KEEPER_URL` (default: `http://localhost:8090`). Without it, BMW login
requests fail before the provided credentials are verified. Set
`BMW_SSO_ENABLED=false` if BMW SSO is not needed for local development.

On Windows PowerShell, replace `.venv/bin/python` with `.venv\Scripts\python.exe`.

### Windows Development

After completing the one-time setup above, start the complete local development
stack with a single command:

```powershell
npm run dev
```

The launcher reuses running services and starts any missing MongoDB,
session-keeper, backend, or frontend process. Backend changes reload through
nodemon, frontend changes reload through Vite, and session-keeper changes reload
when it is started by the launcher.

### Docker Deployment

```bash
cp .env.example .env
# Edit .env with your configuration

# BMW deployment: starts API, session keeper, MongoDB, and supporting services
docker compose -f deploy-compose.yml up --build -d
```

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express |
| Frontend | React, TypeScript, Tailwind CSS |
| Database | MongoDB |
| AI | Multi-model support (OpenAI-compatible APIs, local LLMs) |
| Tooling | Model Context Protocol (MCP) servers |

## Acknowledgements

This project is built on [LibreChat](https://github.com/danny-avila/LibreChat) by Danny Avila. We gratefully acknowledge the upstream project and its community.

## License

This project inherits the MIT License from the upstream LibreChat project. See [LICENSE](LICENSE) for details.

## Links

- **GitHub**: [github.com/tonyoorz/OpenTPM](https://github.com/tonyoorz/OpenTPM)
- **Upstream**: [github.com/danny-avila/LibreChat](https://github.com/danny-avila/LibreChat)
