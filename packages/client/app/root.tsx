import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root";
import "./app.css";

export function Layout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="ja">
			<head>
				<meta charSet="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<Meta />
				<Links />
			</head>
			<body>
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export default function App() {
	return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
	let message = "エラー";
	let details = "予期せぬエラーが発生しました。";

	if (isRouteErrorResponse(error)) {
		message = error.status === 404 ? "404" : "エラー";
		details =
			error.status === 404
				? "ページが見つかりませんでした。"
				: error.statusText || details;
	}

	return (
		<main className="min-h-screen flex items-center justify-center">
			<div className="text-center">
				<h1 className="text-4xl font-bold text-gray-900">{message}</h1>
				<p className="mt-4 text-gray-600">{details}</p>
			</div>
		</main>
	);
}
