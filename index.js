#!/usr/bin/env node
/**
 * index.js — dead-doctor
 * Dead code detector for TypeScript and Next.js codebases.
 * Built by NoctisNova — noctisnova.com
 */

import * as p from "@clack/prompts";
import boxen from "boxen";
import chalk from "chalk";
import clipboardy from "clipboardy";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  scanUnusedImports,
  scanDeadPages,
  scanEmptyFiles,
  scanZombieDependencies,
  scanCommentedCodeBlocks,
  scanUnreachableCode,
  computeProjectSize,
} from "./src/scanner.js";

import { runGraphScans } from "./src/graph.js";
import { writeCleanupScripts } from "./src/fix.js";

import {
  renderProgressBar,
  renderScoreBadge,
  renderDashboard,
  buildAgentPrompt,
} from "./src/ui.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPORT_FILE = "./.dead-doctor-report.json";
const VERSION     = "1.0.0";

const HELP_TEXT = `
${chalk.bold("dead-doctor")}  v${VERSION}
Dead code detector for TypeScript and Next.js codebases.
Built by NoctisNova — noctisnova.com

${chalk.bold("Usage")}
  dead-doctor [options] [path]

${chalk.bold("Arguments")}
  path          Root directory to scan (default: current working directory)

${chalk.bold("Options")}
  --json        Output raw JSON report to stdout (CI mode, exit 1 if issues found)
  --no-ai       Skip the agent hand-off menu
  --version, -v Print version and exit
  --help, -h    Show this help message

${chalk.bold("What it detects")}
  ● Dead files       — whole modules unreachable from any entry point (import-graph BFS)
  ● Unused exports   — exported symbols proven unused by resolving every import edge
  ● Duplicate files  — byte-identical modules (after stripping comments/whitespace)
  ● Dead pages       — Next.js App Router pages with no inbound links
  ● Unused imports   — imports brought in but never used in the file
  ● Empty files      — source files with no meaningful content
  ● Zombie deps      — packages in package.json never imported in code
  ● Commented blocks — large commented-out code blocks (≥8 lines)
  ● Unreachable code — code after unconditional return / throw

${chalk.bold("Cleanup scripts")}
  The agent menu can generate dead-doctor-cleanup.sh / .ps1 / .md — reviewable
  git-rm + npm-uninstall commands. Nothing is deleted automatically.

${chalk.bold("Examples")}
  dead-doctor
  dead-doctor ./my-nextjs-app
  dead-doctor --json > .dead-doctor-report.json
  dead-doctor --no-ai ./src
`.trim();

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

function parseCLIArgs() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        json:    { type: "boolean", default: false },
        "no-ai": { type: "boolean", default: false },
        version: { type: "boolean", short: "v", default: false },
        help:    { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }
  return {
    projectPath: parsed.positionals[0] ?? process.cwd(),
    jsonMode:    parsed.values.json,
    noAi:        parsed.values["no-ai"],
    showVersion: parsed.values.version,
    showHelp:    parsed.values.help,
  };
}

// ---------------------------------------------------------------------------
// Score reveal animation
// ---------------------------------------------------------------------------

async function animateScoreReveal(score) {
  const frames = 40;
  process.stdout.write("\x1B[?25l");
  for (let i = 0; i <= frames; i++) {
    const current = Math.round(easeOut(i / frames) * score);
    process.stdout.write(`\r  ${renderProgressBar(current)}  ${renderScoreBadge(current)}   `);
    await sleep(16);
  }
  process.stdout.write("\x1B[?25h\n\n");
}

// ---------------------------------------------------------------------------
// AI hand-off helpers
// ---------------------------------------------------------------------------

function handOffToClaude(prompt) {
  const reportPath = path.resolve(REPORT_FILE);
  if (!fs.existsSync(reportPath)) {
    p.log.warn("Report file not found — run dead-doctor first.");
    return;
  }
  const safePrompt = prompt.replace(/"/g, '\\"');
  p.log.step(chalk.dim("Launching Claude Code…"));
  try {
    execSync(`claude -p "${safePrompt}"`, { stdio: "inherit", shell: true, cwd: process.cwd() });
  } catch (err) {
    if (err.status === 127 || /not found|is not recognized/i.test(err.message ?? "")) {
      p.log.error(
        chalk.red("The `claude` CLI was not found in your PATH.\n") +
        chalk.dim("  Install it: https://docs.anthropic.com/en/docs/claude-code/getting-started")
      );
    } else {
      p.log.warn(chalk.yellow(`Claude exited with code ${err.status ?? "unknown"}.`));
    }
  }
}

async function copyToClipboard(prompt) {
  try {
    await clipboardy.write(prompt);
    p.log.success(chalk.green("Prompt copied to clipboard!"));
    p.log.info(chalk.dim("Paste it into Cursor, ChatGPT, or any AI assistant."));
  } catch (err) {
    p.log.error(chalk.red(`Clipboard write failed: ${err.message}`));
  }
}

function printPrompt(prompt) {
  console.log();
  console.log(
    boxen(chalk.white(prompt), {
      title: chalk.bold.yellow(" Dead Code Cleanup Prompt "),
      titleAlignment: "center",
      padding: { top: 1, bottom: 1, left: 2, right: 2 },
      margin: { top: 0, bottom: 1 },
      borderStyle: "round",
      borderColor: "yellow",
    })
  );
}

// ---------------------------------------------------------------------------
// Multi-phase scan
// ---------------------------------------------------------------------------

async function runPhasedScans({ projectPath, quiet = false }) {
  const spinner = quiet ? null : p.spinner();
  const say = async (msg, ms = 200) => {
    if (spinner) { spinner.message(chalk.dim(msg)); await sleep(ms); }
  };

  if (spinner) spinner.start(chalk.dim("Discovering source files…"));
  if (!quiet) await sleep(300);

  const stats = computeProjectSize(projectPath);
  if (spinner) {
    spinner.message(
      chalk.dim(`Found `) +
      chalk.white(stats.files) +
      chalk.dim(` source files (${stats.kb} KB) — beginning analysis…`)
    );
    await sleep(400);
  }

  // Phase 2 — Import-dependency graph: dead files, precise unused exports, duplicates
  await say("Building import-dependency graph…", 250);
  await say("Resolving entry points & tracing reachability…", 250);
  const { issues: graphIssuesRaw, graphStats } = await runGraphScans(projectPath);

  // Phase 3 — Unused imports
  await say("Scanning for unused imports…");
  const unusedImportIssues = await scanUnusedImports(projectPath);

  // Phase 4 — Dead pages
  await say("Checking Next.js pages for missing links…");
  const deadPageIssues = await scanDeadPages(projectPath);

  // Phase 5 — Empty files
  await say("Finding empty and hollow files…");
  const emptyFileIssues = await scanEmptyFiles(projectPath);

  // Phase 6 — Zombie dependencies
  await say("Auditing package.json for zombie dependencies…");
  const zombieDepIssues = await scanZombieDependencies(projectPath);

  // Phase 7 — Commented blocks
  await say("Hunting for commented-out code blocks…");
  const commentBlockIssues = await scanCommentedCodeBlocks(projectPath);

  // Phase 8 — Unreachable code (ts-morph AST)
  await say("Detecting unreachable code…");
  const unreachableIssues = await scanUnreachableCode(projectPath);

  // Compile + score
  await say("Computing cleanliness score…", 350);

  // Dedupe: an unreachable "dead-file" that is ALSO empty shouldn't be double-counted —
  // the empty-file rule already owns it (more specific + more actionable).
  const emptyPaths = new Set(emptyFileIssues.map((i) => i.file));
  const graphIssues = graphIssuesRaw.filter(
    (i) => !(i.rule === "dead-file" && emptyPaths.has(i.file))
  );

  const deadFileIssues   = graphIssues.filter((i) => i.rule === "dead-file");
  const unusedExportIssues = graphIssues.filter((i) => i.rule === "unused-export");
  const duplicateIssues  = graphIssues.filter((i) => i.rule === "duplicate-file");

  const issues = [
    ...graphIssues,
    ...unusedImportIssues,
    ...deadPageIssues,
    ...emptyFileIssues,
    ...zombieDepIssues,
    ...commentBlockIssues,
    ...unreachableIssues,
  ];

  const totalPenalty = issues.reduce((s, i) => s + i.penalty, 0);
  const score        = Math.max(0, 100 - totalPenalty);

  stats.reclaimableKb = graphStats?.reclaimableKb ?? 0;

  try {
    fs.writeFileSync(
      REPORT_FILE,
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        projectPath: path.resolve(projectPath),
        score,
        totalPenalty,
        issueCount: issues.length,
        stats,
        graphStats,
        breakdown: {
          deadFiles:       deadFileIssues.length,
          unusedExports:   unusedExportIssues.length,
          duplicateFiles:  duplicateIssues.length,
          unusedImports:   unusedImportIssues.length,
          deadPages:       deadPageIssues.length,
          emptyFiles:      emptyFileIssues.length,
          zombieDeps:      zombieDepIssues.length,
          commentedBlocks: commentBlockIssues.length,
          unreachableCode: unreachableIssues.length,
        },
        issues,
      }, null, 2),
      "utf-8"
    );
  } catch { /* non-fatal */ }

  if (spinner) {
    const doneMsg = issues.length === 0
      ? chalk.green("Done — zero dead code found!")
      : chalk.yellow(`Done — ${issues.length} dead code issue${issues.length !== 1 ? "s" : ""} found.`);
    spinner.stop(doneMsg);
  }

  return { issues, totalPenalty, score, stats, graphStats };
}

// ---------------------------------------------------------------------------
// Arrow-key hand-off menu
// ---------------------------------------------------------------------------

async function showHandOffMenu(issues, stats, graphStats) {
  if (issues.length === 0) {
    p.log.success(chalk.green("Nothing to clean up — codebase is spotless!"));
    return;
  }

  const reportPath  = path.resolve(REPORT_FILE);
  const agentPrompt = buildAgentPrompt(issues, reportPath, stats);

  console.log();

  const choice = await p.select({
    message: chalk.bold("What do you want to do with these dead code issues?"),
    options: [
      {
        value: "claude",
        label: chalk.cyan.bold("Send to Claude Code"),
        hint: "runs `claude -p \"...\"` — Claude reads the report and removes dead code",
      },
      {
        value: "scripts",
        label: chalk.green.bold("Generate cleanup scripts"),
        hint: "writes reviewable git-rm / npm-uninstall scripts (.sh, .ps1, .md)",
      },
      {
        value: "clipboard",
        label: chalk.magenta.bold("Copy prompt to clipboard"),
        hint: "paste into Cursor, ChatGPT, Claude.ai, or any AI assistant",
      },
      {
        value: "print",
        label: chalk.yellow.bold("Print prompt in terminal"),
        hint: "display the full cleanup briefing in your shell",
      },
      {
        value: "skip",
        label: chalk.dim("Skip"),
        hint: "exit — report saved to " + chalk.white(".dead-doctor-report.json"),
      },
    ],
  });

  if (p.isCancel(choice)) { p.cancel("Cancelled."); process.exit(0); }

  console.log();

  switch (choice) {
    case "claude":
      handOffToClaude(agentPrompt);
      break;
    case "scripts": {
      const { written, plan } = writeCleanupScripts(process.cwd(), issues, stats, graphStats);
      if (written.length === 0) {
        p.log.error(chalk.red("Could not write cleanup scripts (permission denied?)."));
        break;
      }
      const fileCount = plan.deletions.length;
      const depCount  = plan.depRemovals.length;
      p.log.success(chalk.green("Cleanup scripts generated:"));
      for (const f of written) p.log.info(chalk.dim("  • ") + chalk.cyan(path.basename(f)));
      p.log.info(
        chalk.dim(`Ready to remove `) + chalk.white(`${fileCount} file${fileCount !== 1 ? "s" : ""}`) +
        chalk.dim(depCount ? ` and uninstall ${depCount} package${depCount !== 1 ? "s" : ""}` : "") +
        chalk.dim(`. Review then run `) + chalk.white("bash dead-doctor-cleanup.sh") +
        chalk.dim(" (or the .ps1 on Windows).")
      );
      break;
    }
    case "clipboard":
      await copyToClipboard(agentPrompt);
      break;
    case "print":
      printPrompt(agentPrompt);
      p.log.info(chalk.dim("Report saved to: ") + chalk.cyan(reportPath));
      break;
    case "skip":
      p.log.info(chalk.dim("Report saved to: ") + chalk.cyan(reportPath));
      break;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCLIArgs();

  if (args.showVersion) { console.log(`dead-doctor v${VERSION}`); process.exit(0); }
  if (args.showHelp)    { console.log(HELP_TEXT);                 process.exit(0); }

  const resolvedProject = path.resolve(args.projectPath);
  if (!fs.existsSync(resolvedProject)) {
    console.error(chalk.red(`Error: path does not exist — ${resolvedProject}`));
    process.exit(1);
  }

  // ── CI / JSON mode ─────────────────────────────────────────────────────────
  if (args.jsonMode) {
    const { issues, score, totalPenalty, stats, graphStats } =
      await runPhasedScans({ projectPath: args.projectPath, quiet: true });
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      projectPath: resolvedProject,
      score, totalPenalty, stats, graphStats,
      issueCount: issues.length,
      issues,
    }, null, 2));
    process.exit(issues.length > 0 ? 1 : 0);
  }

  // ── Interactive mode ────────────────────────────────────────────────────────
  console.log();
  p.intro(
    chalk.bgYellow.black.bold("  dead-doctor  ") +
    chalk.dim(`  v${VERSION}  ·  Dead code detector  ·  by `) +
    chalk.magenta("NoctisNova") +
    chalk.dim("  noctisnova.com")
  );

  console.log();

  let scanResult;
  try {
    scanResult = await runPhasedScans({ projectPath: args.projectPath });
  } catch (err) {
    p.log.error(chalk.red(err.message));
    p.outro(chalk.red("dead-doctor encountered an error."));
    process.exit(1);
  }

  const { issues, score, totalPenalty, stats, graphStats } = scanResult;

  // Score reveal animation
  console.log();
  await animateScoreReveal(score);

  // Full dashboard
  console.log(renderDashboard({ score, totalPenalty, issues, stats }));

  // Breakdown summary
  if (issues.length > 0) {
    const order = [
      ["unreachable-code", "unreachable code"],
      ["dead-file",        "dead files"],
      ["dead-page",        "dead pages"],
      ["duplicate-file",   "duplicate files"],
      ["zombie-dep",       "zombie deps"],
      ["unused-export",    "unused exports"],
      ["comment-block",    "commented blocks"],
      ["unused-import",    "unused imports"],
      ["empty-file",       "empty files"],
    ];
    const parts = order
      .map(([rule, label]) => {
        const n = issues.filter((i) => i.rule === rule).length;
        return n > 0 ? chalk.dim(`${n} ${label}`) : null;
      })
      .filter(Boolean);
    if (parts.length > 0) {
      p.log.info("Breakdown: " + parts.join(chalk.dim("  ·  ")));
    }
  }

  // Agent hand-off
  if (!args.noAi) {
    await showHandOffMenu(issues, stats, graphStats);
  } else {
    p.log.info(chalk.dim("Report saved to: ") + chalk.cyan(path.resolve(REPORT_FILE)));
  }

  console.log();
  p.outro(
    issues.length === 0
      ? chalk.green("Zero dead code — clean codebase. Keep it that way.")
      : chalk.yellow(`${issues.length} issue${issues.length !== 1 ? "s" : ""} to clean up. Delete them — git has your back.`)
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(chalk.red("\nUnexpected error:"), err.message ?? err);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
