import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { matchCache, putCache } from "./cache";
import { fetchFromOrigin } from "./origin";
import { getImageQuerySchema, putImageQuerySchema } from "./schemas";
import { vValidator } from "./validator";

type Bindings = {
	ORIGIN_URL: string;
	IMAGE_STORE: R2Bucket;
	CLIENT_URL: string;
};

// 最大ファイルサイズ
const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

/**
 * key の妥当性を検証する（パストラバーサル対策）。
 */
function validateKey(key: string): boolean {
	// 空文字、パストラバーサルパターンを拒否
	if (!key || key.includes("..") || key.startsWith("/") || key.includes("//")) {
		return false;
	}
	// 許可する文字セットのみ（英数字、ハイフン、アンダースコア、スラッシュ、ピリオド）
	const safePattern = /^[a-zA-Z0-9\-_/.]+$/;
	return safePattern.test(key);
}

/**
 * JPEG フォーマットを検出する。
 */
function isJpeg(bytes: Uint8Array): boolean {
	return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * PNG フォーマットを検出する。
 */
function isPng(bytes: Uint8Array): boolean {
	return (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	);
}

/**
 * GIF フォーマットを検出する。
 */
function isGif(bytes: Uint8Array): boolean {
	return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
}

/**
 * WebP フォーマットを検出する。
 */
function isWebP(bytes: Uint8Array): boolean {
	return (
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	);
}

/**
 * AVIF フォーマットを検出する。
 * ISO Base Media File Format の ftyp box を確認。
 */
function isAvif(bytes: Uint8Array): boolean {
	const isFtypBox =
		bytes[4] === 0x66 && // 'f'
		bytes[5] === 0x74 && // 't'
		bytes[6] === 0x79 && // 'y'
		bytes[7] === 0x70; // 'p'

	const isAvifBrand =
		(bytes[8] === 0x61 && // 'a'
			bytes[9] === 0x76 && // 'v'
			bytes[10] === 0x69 && // 'i'
			bytes[11] === 0x66) || // 'f' (avif)
		(bytes[8] === 0x61 && // 'a'
			bytes[9] === 0x76 && // 'v'
			bytes[10] === 0x69 && // 'i'
			bytes[11] === 0x73); // 's' (avis)

	return isFtypBox && isAvifBrand;
}

/**
 * ファイル内容から実際の MIME タイプを検証する。
 */
function detectMimeType(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer.slice(0, 16));

	if (isJpeg(bytes)) return "image/jpeg";
	if (isPng(bytes)) return "image/png";
	if (isGif(bytes)) return "image/gif";
	if (isWebP(bytes)) return "image/webp";
	if (isAvif(bytes)) return "image/avif";

	throw new Error("Unsupported file type");
}

/**
 * キャッシュされたレスポンスを取得する。
 */
async function getCachedResponse(request: Request): Promise<Response | null> {
	const cached = await matchCache(request);
	if (!cached) return null;

	const headers = new Headers(cached.headers);
	headers.set("X-Cache", "HIT");
	return new Response(cached.body, {
		status: cached.status,
		statusText: cached.statusText,
		headers,
	});
}

/**
 * オリジンから画像を取得し、キャッシュに保存する。
 */
async function fetchAndCacheFromOrigin(
	c: Context<{ Bindings: Bindings }>,
	originUrl: string,
	key: string,
	params: URLSearchParams,
): Promise<Response> {
	const originResponse = await fetchFromOrigin(originUrl, key, params);
	const cacheableResponse = originResponse.clone();

	const response = new Response(originResponse.body, {
		status: originResponse.status,
		statusText: originResponse.statusText,
		headers: new Headers(originResponse.headers),
	});
	response.headers.set("X-Cache", "MISS");

	if (originResponse.ok) {
		c.executionCtx.waitUntil(putCache(c.req.raw, cacheableResponse));
	}

	return response;
}

const app = new Hono<{ Bindings: Bindings }>()
	.use(async (c, next) => {
		// CLIENT_URL の存在チェック（セキュリティ強化）
		if (!c.env.CLIENT_URL) {
			return c.json(
				{ error: "CORS configuration error: CLIENT_URL not set" },
				500,
			);
		}
		await next();
	})
	.use((c, next) => {
		const corsMiddleware = cors({
			origin: c.env.CLIENT_URL,
			allowMethods: ["GET", "PUT", "OPTIONS"],
			allowHeaders: ["Content-Type", "Content-Length"],
			exposeHeaders: ["X-Cache"],
		});
		return corsMiddleware(c, next);
	})
	/**
	 * GET /images/*
	 * 画像を取得する（キャッシュ → オリジン → キャッシュ保存）
	 * パスパラメータ: key (例: /images/test/123.png)
	 * クエリパラメータ: w, h, f
	 */
	.get("/images/*", vValidator("query", getImageQuerySchema), async (c) => {
		const key = c.req.path.replace(/^\/images\//, "");

		if (!validateKey(key)) {
			return c.json({ error: "Invalid key format" }, 400);
		}

		const cached = await getCachedResponse(c.req.raw);
		if (cached) return cached;

		const params = new URL(c.req.url).searchParams;
		return fetchAndCacheFromOrigin(c, c.env.ORIGIN_URL, key, params);
	})
	/**
	 * PUT /images
	 * R2 に画像を直接アップロード（動作確認用）
	 * クエリパラメータ: key
	 */
	.put("/images", vValidator("query", putImageQuerySchema), async (c) => {
		const { key } = c.req.valid("query");

		if (!validateKey(key)) {
			return c.json({ error: "Invalid key format" }, 400);
		}

		// ファイルサイズ制限チェック（Content-Length ヘッダー）
		const contentLength = c.req.header("Content-Length");
		if (contentLength && Number.parseInt(contentLength, 10) > MAX_FILE_SIZE) {
			return c.json(
				{
					error: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB`,
				},
				413,
			);
		}

		try {
			const body = await c.req.arrayBuffer();

			// 実際のサイズも検証
			if (body.byteLength > MAX_FILE_SIZE) {
				return c.json(
					{
						error: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB`,
					},
					413,
				);
			}

			// ファイル内容から MIME タイプを検証
			const contentType = detectMimeType(body);

			await c.env.IMAGE_STORE.put(key, body, {
				httpMetadata: { contentType },
			});

			return c.json({ success: true, key }, 201);
		} catch (error) {
			// クライアント起因のエラーとサーバーエラーを判別し、適切なステータスコードを返す
			if (
				error instanceof Error &&
				error.message &&
				error.message.includes("Unsupported file type")
			) {
				return c.json({ error: "Unsupported media type" }, 415);
			}

			// それ以外の予期しないエラーは 500 とし、内部情報は返さない
			return c.json({ error: "Internal server error" }, 500);
		}
	})
	/**
	 * ヘルスチェック
	 */
	.get("/health", (c) => {
		return c.json({ status: "ok" });
	});

export const api = app;
export type Api = typeof api;

export default api;
