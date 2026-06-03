# dead-doctor

Static analysis CLI that finds **dead code, unused exports, ghost pages, zombie dependencies, and leftover commented blocks** in TypeScript and Next.js codebases.

Built by [NoctisNova](https://noctisnova.com).

## Install & run

No install required:

```bash
npx dead-doctor
npx dead-doctor ./my-app
npx dead-doctor --json
npx dead-doctor --no-ai
```

Global install (optional):

```bash
npm install -g dead-doctor
dead-doctor
```

## What it detects

- **Dead files** — whole modules unreachable from any entry point (import-graph BFS)
- **Unused exports** — exported symbols proven unused by resolving every import edge
- **Duplicate files** — byte-identical modules (after stripping comments/whitespace)
- **Dead pages** — Next.js App Router pages with no inbound links
- **Unused imports** — imports brought in but never used in the file
- **Empty files** — source files with no meaningful content
- **Zombie deps** — packages in `package.json` never imported in code
- **Commented blocks** — large commented-out code blocks (≥ 8 lines)
- **Unreachable code** — code after unconditional `return` / `throw`

Produces a scored health report (0–100) and saves `.dead-doctor-report.json` for AI-assisted fixes.

## Cleanup scripts

The agent menu can generate `dead-doctor-cleanup.sh` / `.ps1` / `.md` — reviewable `git rm` and `npm uninstall` commands. Nothing is deleted automatically.

## Requirements

- Node.js **18+**

## Links

- **Homepage:** https://noctisnova.com
- **Repository:** https://github.com/noctisnova/dead-doctor
- **Issues:** https://github.com/noctisnova/dead-doctor/issues

## License

MIT
