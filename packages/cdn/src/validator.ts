import type { ValidationTargets } from "hono";
import { validator } from "hono/validator";
import type { GenericSchema, GenericSchemaAsync } from "valibot";
import { safeParseAsync } from "valibot";

export const vValidator = <
	Target extends keyof ValidationTargets,
	S extends GenericSchema | GenericSchemaAsync,
>(
	target: Target,
	schema: S,
) =>
	validator(target, async (value, c) => {
		const result = await safeParseAsync(schema, value);

		if (!result.success) {
			return c.json(
				{
					error: `Invalid ${target}: ${result.issues
						.map((issue) => issue.message)
						.join(", ")}`,
				},
				400,
			);
		}

		return result.output;
	});
