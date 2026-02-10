import {
	type InferOutput,
	integer,
	maxValue,
	minLength,
	minValue,
	number,
	object,
	optional,
	picklist,
	pipe,
	string,
	transform,
} from "valibot";

/**
 * GET /images/* のクエリパラメータスキーマ
 * パスパラメータで key を取得し、クエリパラメータで変換オプションを指定
 */
export const getImageQuerySchema = object({
	w: optional(
		pipe(
			string(),
			transform((v) => Number.parseInt(v, 10)),
			number("width must be a number"),
			integer("width must be an integer"),
			minValue(1, "width must be at least 1"),
			maxValue(4000, "width must be at most 4000"),
		),
	),
	h: optional(
		pipe(
			string(),
			transform((v) => Number.parseInt(v, 10)),
			number("height must be a number"),
			integer("height must be an integer"),
			minValue(1, "height must be at least 1"),
			maxValue(4000, "height must be at most 4000"),
		),
	),
	f: optional(
		picklist(
			["jpeg", "png", "webp", "avif"],
			"format must be jpeg, png, webp, or avif",
		),
	),
});

export type GetImageQuery = InferOutput<typeof getImageQuerySchema>;

/**
 * PUT /images のクエリパラメータスキーマ
 */
export const putImageQuerySchema = object({
	key: pipe(string("key is required"), minLength(1, "key cannot be empty")),
});

export type PutImageQuery = InferOutput<typeof putImageQuerySchema>;
