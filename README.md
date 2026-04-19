# 🧜 Nami - AI Coding Agent

<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@react-frameui/nami-coding-agent"><img alt="NPM Version" src="https://img.shields.io/npm/v/@react-frameui/nami-coding-agent?style=flat-square&label=npm" /></a>
</p>

> **Powerful AI coding agent** - An interactive CLI that reads files, edits code, executes commands, and builds complete projects with AI.

## Features

- **Interactive CLI** - Chat with AI to write, edit, and debug code
- **Multi-Provider LLM Support** - OpenAI, Anthropic, Google, Azure, AWS Bedrock, and more
- **Powerful Tools** - Read, write, edit, grep, find, bash - all the tools you need
- **Session History** - Resume previous conversations anytime
- **Extensions** - Customize with your own extensions
- **Terminal UI** - Beautiful terminal interface with syntax highlighting
- **Web UI** - Also available as web components

## Quick Install

```bash
npm install -g @react-frameui/nami-coding-agent
```

## Usage

```bash
# Start interactive session
nami

# Run a single prompt
nami -p "Hello, write a hello world program"

# List available models
nami models
```

## Configuration

Nami stores config in `~/.nami/agent/`:

- `settings.json` - API keys and preferences
- `sessions/` - Session history
- `skills/` - Custom skills

## Packages

| Package | Description |
|---------|-------------|
| `@react-frameui/nami-ai` | Unified multi-provider LLM API |
| `@react-frameui/nami-agent-core` | Agent runtime with tool calling |
| `@react-frameui/nami-coding-agent` | Interactive coding agent CLI |
| `@react-frameui/nami-tui` | Terminal UI library |
| `@react-frameui/nami-web-ui` | Web components for chat interfaces |

## Development

```bash
# Clone and setup
git clone https://github.com/IamNishant51/nami.git
cd nami
npm install

# Build
npm run build

# Test
./test.sh
```

## License

MIT - [Nishant Unavane](https://github.com/IamNishant51)