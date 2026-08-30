type Decimal = Readonly<{ coefficient: bigint; scale: number }>;

function parseDecimal(value: string): Decimal {
	if (!/^-?\d+(?:\.\d+)?$/u.test(value)) {
		throw new Error("Inventory quantity is not an exact decimal.");
	}
	const negative = value.startsWith("-");
	const unsigned = negative ? value.slice(1) : value;
	const [whole, fraction = ""] = unsigned.split(".");
	const coefficient = BigInt(`${whole}${fraction}`);
	return {
		coefficient: negative ? -coefficient : coefficient,
		scale: fraction.length,
	};
}

function powerOfTen(exponent: number): bigint {
	return 10n ** BigInt(exponent);
}

function formatDecimal(decimal: Decimal): string {
	const negative = decimal.coefficient < 0n;
	const absolute = negative ? -decimal.coefficient : decimal.coefficient;
	if (decimal.scale === 0) {
		return `${negative ? "-" : ""}${absolute}`;
	}
	const digits = absolute.toString().padStart(decimal.scale + 1, "0");
	const whole = digits.slice(0, -decimal.scale);
	const fraction = digits.slice(-decimal.scale).replace(/0+$/u, "");
	const magnitude = fraction.length === 0 ? whole : `${whole}.${fraction}`;
	return absolute === 0n ? "0" : `${negative ? "-" : ""}${magnitude}`;
}

export function addExactDecimal(left: string, right: string): string {
	const a = parseDecimal(left);
	const b = parseDecimal(right);
	const scale = Math.max(a.scale, b.scale);
	return formatDecimal({
		coefficient:
			a.coefficient * powerOfTen(scale - a.scale) +
			b.coefficient * powerOfTen(scale - b.scale),
		scale,
	});
}

export function subtractExactDecimal(left: string, right: string): string {
	const b = parseDecimal(right);
	return addExactDecimal(
		left,
		formatDecimal({ coefficient: -b.coefficient, scale: b.scale }),
	);
}
