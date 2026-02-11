import { useCallback, useRef, useState } from "react";
import type { Route } from "./+types/home";

export function meta(_args: Route.MetaArgs) {
	return [
		{ title: "画像配信システム デモ" },
		{ name: "description", content: "画像のアップロードとリサイズプレビュー" },
	];
}

export function loader({ context }: Route.LoaderArgs) {
	return { cdnUrl: context.cloudflare.env.CDN_URL };
}

type ImageParams = {
	width: number;
	height: number;
	format: "jpeg" | "png" | "webp" | "avif";
	quality: number;
};

export default function Home({ loaderData }: Route.ComponentProps) {
	const CDN_URL = loaderData.cdnUrl;

	const [uploadedKey, setUploadedKey] = useState<string | null>(null);
	const [uploading, setUploading] = useState(false);
	const [dragActive, setDragActive] = useState(false);
	const [params, setParams] = useState<ImageParams>({
		width: 800,
		height: 600,
		format: "webp",
		quality: 80,
	});
	const [cacheStatus, setCacheStatus] = useState<string>("");
	const fileInputRef = useRef<HTMLInputElement>(null);

	const handleDrag = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (e.type === "dragenter" || e.type === "dragover") {
			setDragActive(true);
		} else if (e.type === "dragleave") {
			setDragActive(false);
		}
	}, []);

	const uploadImage = useCallback(
		async (file: File): Promise<string> => {
			const key = `test/${Date.now()}_${file.name}`;
			const response = await fetch(
				`${CDN_URL}/images?key=${encodeURIComponent(key)}`,
				{
					method: "PUT",
					body: file,
				},
			);

			if (!response.ok) {
				throw new Error(`Upload failed: ${response.statusText}`);
			}

			return key;
		},
		[CDN_URL],
	);

	const handleFile = useCallback(
		async (file: File) => {
			if (!file.type.startsWith("image/")) {
				alert("画像ファイルを選択してください");
				return;
			}

			setUploading(true);
			try {
				const key = await uploadImage(file);
				setUploadedKey(key);
				setCacheStatus("");
			} catch (error) {
				console.error("Upload error:", error);
				alert(
					"アップロードに失敗しました。しばらく経ってから再度お試しください。",
				);
			} finally {
				setUploading(false);
			}
		},
		[uploadImage],
	);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setDragActive(false);

			e.dataTransfer.files?.[0] && handleFile(e.dataTransfer.files[0]);
		},
		[handleFile],
	);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			e.preventDefault();
			e.target.files?.[0] && handleFile(e.target.files[0]);
		},
		[handleFile],
	);

	const onButtonClick = () => {
		fileInputRef.current?.click();
	};

	const getImageUrl = () => {
		if (!uploadedKey) return "";
		const searchParams = new URLSearchParams({
			w: params.width.toString(),
			h: params.height.toString(),
			f: params.format,
		});
		return `${CDN_URL}/images/${uploadedKey}?${searchParams}`;
	};

	const handleImageLoad = async () => {
		if (!uploadedKey) return;
		try {
			const response = await fetch(getImageUrl());
			const xCache = response.headers.get("X-Cache") || "UNKNOWN";
			setCacheStatus(xCache);
		} catch (error) {
			console.error("Failed to fetch cache status:", error);
			setCacheStatus("ERROR");
		}
	};

	return (
		<div className="min-h-screen bg-gray-50 py-8">
			<div className="max-w-4xl mx-auto px-4">
				<h1 className="text-3xl font-bold text-gray-900 mb-8">
					画像配信システム デモ
				</h1>

				{/* アップロード エリア */}
				<div className="bg-white rounded-lg shadow p-6 mb-6">
					<h2 className="text-xl font-semibold text-gray-800 mb-4">
						1. 画像をアップロード
					</h2>
					<label
						className={`relative border-2 border-dashed rounded-lg p-8 text-center block cursor-pointer ${
							dragActive
								? "border-blue-500 bg-blue-50"
								: "border-gray-300 bg-gray-50"
						}`}
						onDragEnter={handleDrag}
						onDragLeave={handleDrag}
						onDragOver={handleDrag}
						onDrop={handleDrop}
					>
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							onChange={handleChange}
							className="hidden"
						/>
						{uploading ? (
							<p className="text-gray-600">アップロード中...</p>
						) : (
							<>
								<p className="text-gray-600 mb-2">
									ここに画像をドラッグ&ドロップ
								</p>
								<p className="text-gray-500 text-sm mb-4">または</p>
								<button
									onClick={onButtonClick}
									className="bg-blue-500 hover:bg-blue-600 text-white font-medium py-2 px-4 rounded"
									type="button"
								>
									ファイルを選択
								</button>
							</>
						)}
					</label>
					{uploadedKey && (
						<p className="text-sm text-gray-600 mt-2">
							アップロード完了: {uploadedKey}
						</p>
					)}
				</div>

				{/* パラメータ調整 */}
				{uploadedKey && (
					<>
						<div className="bg-white rounded-lg shadow p-6 mb-6">
							<h2 className="text-xl font-semibold text-gray-800 mb-4">
								2. リサイズパラメータを調整
							</h2>
							<div className="grid grid-cols-2 gap-4">
								<div>
									<label
										htmlFor="width-input"
										className="block text-sm font-medium text-gray-700 mb-1"
									>
										幅 (width)
									</label>
									<input
										id="width-input"
										type="number"
										value={params.width}
										onChange={(e) =>
											setParams({ ...params, width: Number(e.target.value) })
										}
										className="w-full border border-gray-300 rounded px-3 py-2"
										min="1"
										max="4000"
									/>
								</div>
								<div>
									<label
										htmlFor="height-input"
										className="block text-sm font-medium text-gray-700 mb-1"
									>
										高さ (height)
									</label>
									<input
										id="height-input"
										type="number"
										value={params.height}
										onChange={(e) =>
											setParams({ ...params, height: Number(e.target.value) })
										}
										className="w-full border border-gray-300 rounded px-3 py-2"
										min="1"
										max="4000"
									/>
								</div>
								<div>
									<label
										htmlFor="format-select"
										className="block text-sm font-medium text-gray-700 mb-1"
									>
										フォーマット (format)
									</label>
									<select
										id="format-select"
										value={params.format}
										onChange={(e) =>
											setParams({
												...params,
												format: e.target.value as ImageParams["format"],
											})
										}
										className="w-full border border-gray-300 rounded px-3 py-2"
									>
										<option value="jpeg">JPEG</option>
										<option value="png">PNG</option>
										<option value="webp">WebP</option>
										<option value="avif">AVIF</option>
									</select>
								</div>
								<div>
									<label
										htmlFor="quality-input"
										className="block text-sm font-medium text-gray-700 mb-1"
									>
										品質 (quality): {params.quality}
									</label>
									<input
										id="quality-input"
										type="range"
										value={params.quality}
										onChange={(e) =>
											setParams({ ...params, quality: Number(e.target.value) })
										}
										className="w-full"
										min="1"
										max="100"
									/>
								</div>
							</div>
						</div>

						{/* プレビュー */}
						<div className="bg-white rounded-lg shadow p-6">
							<div className="flex items-center justify-between mb-4">
								<h2 className="text-xl font-semibold text-gray-800">
									3. プレビュー
								</h2>
								{cacheStatus && (
									<span
										className={`px-3 py-1 rounded text-sm font-medium ${
											cacheStatus === "HIT"
												? "bg-green-100 text-green-800"
												: "bg-yellow-100 text-yellow-800"
										}`}
									>
										Cache: {cacheStatus}
									</span>
								)}
							</div>
							<div className="border border-gray-200 rounded p-4 bg-gray-50">
								<img
									key={getImageUrl()}
									src={getImageUrl()}
									alt="Preview"
									className="max-w-full h-auto mx-auto"
									onLoad={handleImageLoad}
									onError={() => setCacheStatus("ERROR")}
								/>
							</div>
							<p className="text-xs text-gray-500 mt-2 break-all">
								URL: {getImageUrl()}
							</p>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
