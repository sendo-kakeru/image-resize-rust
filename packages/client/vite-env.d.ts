// biome-ignore-all lint/correctness/noUnusedVariables: .d.tsのため参照する必要無し
/// <reference types="vite/client" />

interface ViteTypeOptions {
	strictImportMetaEnv: unknown;
}

interface ImportMetaEnv {
	readonly VITE_CDN_URL: string;
}
interface ImportMeta {
	readonly env: ImportMetaEnv;
}
