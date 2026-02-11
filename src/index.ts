import dotenv from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "ssh2";
import type { ClientChannel } from "ssh2";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath =
	process.env.MCP_SSH_ENV_PATH ??
	path.resolve(rootDir, ".env");

if (fs.existsSync(envPath)) {
	dotenv.config({ path: envPath });
}

const sessions = new Map<string, Client>();
const readySessions = new Set<string>();

const allowedHosts = new Set(
	(process.env.MCP_SSH_ALLOWED_HOSTS ?? "")
		.split(",")
		.map((item: string) => item.trim())
		.filter(Boolean)
);

const defaultHost = process.env.MCP_SSH_DEFAULT_HOST ?? "";
const defaultPort = Number(process.env.MCP_SSH_DEFAULT_PORT ?? 22);
const defaultUsername = process.env.MCP_SSH_DEFAULT_USERNAME ?? "";
const defaultPrivateKeyPath = process.env.MCP_SSH_DEFAULT_PRIVATE_KEY_PATH ?? "";
const defaultPassword = process.env.MCP_SSH_DEFAULT_PASSWORD ?? "";
const defaultPassphrase = process.env.MCP_SSH_DEFAULT_PASSPHRASE ?? "";
const defaultCommand = process.env.MCP_SSH_DEFAULT_COMMAND ?? "";
const defaultLogPath = process.env.MCP_SSH_LOG_PATH ?? "";
const defaultConnectTimeoutMs = Number(
	process.env.MCP_SSH_CONNECT_TIMEOUT_MS ?? 20000
);
const defaultExecTimeoutMs = Number(
	process.env.MCP_SSH_EXEC_TIMEOUT_MS ?? 60000
);
const defaultRemoteLang = process.env.MCP_SSH_REMOTE_LANG ?? "";
const defaultRemoteLcAll = process.env.MCP_SSH_REMOTE_LC_ALL ?? "";

const server = new Server(
	{ name: "mcp-ssh", version: "0.1.0" },
	{ capabilities: { tools: {} } }
);

const isHostAllowed = (host: string): boolean =>
	allowedHosts.size === 0 || allowedHosts.has(host);

const resolvePrivateKey = (privateKey?: string, privateKeyPath?: string): string | undefined => {
	if (privateKey?.trim()) {
		return privateKey;
	}

	if (privateKeyPath?.trim()) {
		const resolvedPath = path.resolve(
			privateKeyPath.replace(/^~(?=\/|$)/, os.homedir())
		);

		return fs.readFileSync(resolvedPath, "utf8");
	}

	if (defaultPrivateKeyPath.trim()) {
		const resolvedPath = path.resolve(
			defaultPrivateKeyPath.replace(/^~(?=\/|$)/, os.homedir())
		);

		return fs.readFileSync(resolvedPath, "utf8");
	}

	return undefined;
};

// Формируем команду с опциональной установкой локали
const buildCommand = (command: string, cwd?: string): string => {
	const shouldSetLocale = Boolean(defaultRemoteLang || defaultRemoteLcAll);
	const localePrefix = shouldSetLocale
		? `env LANG=${defaultRemoteLang || "C"} LC_ALL=${defaultRemoteLcAll || "C"}`
		: "";
	const baseCommand = localePrefix ? `${localePrefix} ${command}` : command;

	return cwd ? `cd ${JSON.stringify(cwd)} && ${baseCommand}` : baseCommand;
};

const asTextResult = (data: unknown) => ({
	content: [
		{
			type: "text" as const,
			text: JSON.stringify(data, null, 2),
		},
	],
});

const writeLog = async (message: string): Promise<void> => {
	if (!defaultLogPath) {
		return;
	}

	if (!message) {
		fs.appendFileSync(defaultLogPath, "\n", "utf8");

		return;
	}

	const timestamp = new Date().toISOString();
	const line = `[${timestamp}] ${message}\n`;

	await fs.promises.appendFile(defaultLogPath, line, "utf8");
};

const writeLogBlock = async (title: string, body: string): Promise<void> => {
	if (!defaultLogPath) {
		return;
	}

	const timestamp = new Date().toISOString();
	const normalizedBody = body.endsWith("\n") ? body : `${body}\n`;
	const block = `[${timestamp}] ${title}\n${normalizedBody}`;

	await fs.promises.appendFile(defaultLogPath, block, "utf8");
};

const unwrapInputSchema = <T>(value: T): T => {
	let current: any = value;

	while (
		current &&
		typeof current === "object" &&
		"inputSchema" in current &&
		Object.keys(current).length === 1
	) {
		current = current.inputSchema;
	}

	return current as T;
};

const normalizePayload = <T extends Record<string, unknown>>(value: T): T => {
	const unwrapped = unwrapInputSchema(value) as Record<string, unknown>;
	const nested =
		unwrapped && typeof unwrapped === "object" && "inputSchema" in unwrapped
			? (unwrapped.inputSchema as Record<string, unknown> | undefined)
			: undefined;

	return nested && typeof nested === "object"
		? ({ ...nested, ...unwrapped } as T)
		: (unwrapped as T);
};

const tools = [
	{
		name: "ssh_connect",
		description: "Подключение по SSH и создание сессии",
		inputSchema: {
			type: "object",
			properties: {
				connectTimeoutMs: { type: "integer" },
			},
			additionalProperties: false,
		},
	},
	{
		name: "ssh_exec",
		description: "Выполнение команды по SSH в существующей сессии или одноразово",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: { type: "string" },
				command: { type: "string" },
				cwd: { type: "string" },
				timeoutMs: { type: "integer" },
			},
			required: ["command"],
			additionalProperties: false,
		},
	},
	{
		name: "ssh_disconnect",
		description: "Отключение SSH сессии",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: { type: "string" },
			},
			required: ["sessionId"],
			additionalProperties: false,
		},
	},
	{
		name: "ssh_list_sessions",
		description: "Список активных SSH сессий",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(
	CallToolRequestSchema,
	(async (request: { params: Record<string, unknown> }) => {
		const params = request.params;
		const name = typeof params.name === "string" ? params.name : "";
		const args =
			(params.arguments as unknown) ??
			(params.input as unknown) ??
			(params.inputSchema as unknown) ??
			params;
		const payload =
			typeof args === "string"
				? ({ command: args } as Record<string, unknown>)
				: normalizePayload((args ?? {}) as Record<string, unknown>);

		if (name === "ssh_connect") {
			if (
				payload.host ||
				payload.port ||
				payload.username ||
				payload.password ||
				payload.privateKey ||
				payload.privateKeyPath
			) {
				throw new Error("Параметры подключения берутся только из .env.");
			}

			const host = defaultHost;
			const port = defaultPort;
			const username = defaultUsername;
			const password = defaultPassword;
			const privateKey = resolvePrivateKey(undefined, undefined);
			const passphrase = defaultPassphrase;
			const connectTimeoutMs =
				(typeof payload.connectTimeoutMs === "number"
					? payload.connectTimeoutMs
					: defaultConnectTimeoutMs) ?? defaultConnectTimeoutMs;

			if (!host || !username) {
				throw new Error("Не указан host или username в .env.");
			}

			if (!isHostAllowed(host)) {
				throw new Error("Хост не разрешён политикой MCP_SSH_ALLOWED_HOSTS.");
			}

			const sessionId = randomUUID();
			const client = new Client();

			sessions.set(sessionId, client);

			const ready = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error("Таймаут подключения по SSH."));
				}, connectTimeoutMs);

				client
					.on("ready", () => {
						clearTimeout(timer);
						readySessions.add(sessionId);
						resolve();
					})
					.on("error", (error: Error) => {
						clearTimeout(timer);
						reject(error);
					})
					.on("close", () => {
						readySessions.delete(sessionId);
						sessions.delete(sessionId);
					});
			});

			client.connect({
				host,
				port,
				username,
				password: password || undefined,
				privateKey,
				passphrase: passphrase || undefined,
				readyTimeout: connectTimeoutMs,
			});

			await ready;

			await writeLog(
				`ssh_connect host=${host} port=${port} username=${username} sessionId=${sessionId}`
			);

			return asTextResult({
				sessionId,
				host,
				port,
				username,
			});
		}

		if (name === "ssh_exec") {
			const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
			const client = sessionId ? sessions.get(sessionId) : undefined;
			const isReady = sessionId ? readySessions.has(sessionId) : false;
			const useSession = Boolean(client && isReady);
			const timeoutMs =
				(typeof payload.timeoutMs === "number" ? payload.timeoutMs : defaultExecTimeoutMs) ??
				defaultExecTimeoutMs;
			const commandValue = payload.command as string | undefined;
			const rawParams = JSON.stringify(params ?? {});
			const rawMatch = rawParams.match(/"command"\s*:\s*"([^"]+)"/);
			const rawCommand = rawMatch?.[1];
			const resolvedCommand = commandValue ?? rawCommand ?? defaultCommand;

			if (!resolvedCommand) {
				return asTextResult({
					error: "Не передана команда для выполнения.",
					received: payload,
					receivedRaw: args ?? {},
					receivedType: typeof args,
				});
			}

			const command = buildCommand(resolvedCommand, payload.cwd as string | undefined);
			const runExec = (activeClient: Client, shouldClose: boolean) =>
				new Promise((resolve, reject) => {
					const timer = setTimeout(() => {
						reject(new Error("Таймаут выполнения команды по SSH."));
					}, timeoutMs);

					activeClient.exec(command, (error: Error | undefined, stream: ClientChannel) => {
						if (error) {
							clearTimeout(timer);
							reject(error);

							return;
						}

						let stdout = "";
						let stderr = "";
						let exitCode: number | null = null;
						let exitSignal: string | null = null;

						stream
							.on("close", (code: number | null, signal: string | null) => {
								clearTimeout(timer);
								exitCode = code;
								exitSignal = signal;
								const result = {
									stdout,
									stderr,
									exitCode,
									exitSignal,
									commandSent: command,
								};

								const stderrBlock = stderr ? `\n[stderr]\n${stderr}` : "";
								void writeLogBlock(
									`ssh_exec ${command}`,
									`${stdout}${stderrBlock}`
								);

								resolve(asTextResult(result));

								if (shouldClose) {
									activeClient.end();
								}
							})
							.on("data", (data: Buffer) => {
								stdout += data.toString("utf8");
							});

						stream.stderr.on("data", (data: Buffer) => {
							stderr += data.toString("utf8");
						});
					});
				});

			if (useSession && client) {
				return await runExec(client, false);
			}

			const host = defaultHost;
			const port = defaultPort;
			const username = defaultUsername;
			const password = defaultPassword;
			const privateKey = resolvePrivateKey(undefined, undefined);
			const passphrase = defaultPassphrase;

			if (!host || !username) {
				throw new Error("Не указан host или username в .env.");
			}

			const oneShotClient = new Client();
			const ready = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error("Таймаут подключения по SSH."));
				}, defaultConnectTimeoutMs);

				oneShotClient
					.on("ready", () => {
						clearTimeout(timer);
						resolve();
					})
					.on("error", (error: Error) => {
						clearTimeout(timer);
						reject(error);
					});
			});

			oneShotClient.connect({
				host,
				port,
				username,
				password: password || undefined,
				privateKey,
				passphrase: passphrase || undefined,
				readyTimeout: defaultConnectTimeoutMs,
			});

			await ready;

			return await runExec(oneShotClient, true);
		}

		if (name === "ssh_disconnect") {
			const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
			const client = sessionId ? sessions.get(sessionId) : undefined;

			if (!client || !sessionId) {
				return asTextResult({ disconnected: false });
			}

			await writeLog(`ssh_disconnect sessionId=${sessionId}`);
			await writeLog(``);

			client.end();
			readySessions.delete(sessionId);
			sessions.delete(sessionId);

			return asTextResult({ disconnected: true });
		}

		if (name === "ssh_list_sessions") {
			const sessionsList = Array.from(readySessions.values());

			await writeLog(`ssh_list_sessions count=${sessionsList.length}`);

			return asTextResult({ sessions: sessionsList });
		}

		throw new Error("Неизвестный инструмент MCP.");
	}) as any
);

const transport = new StdioServerTransport();

await server.connect(transport);
