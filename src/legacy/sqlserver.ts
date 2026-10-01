const collator = new Intl.Collator("en-US", { usage: "sort", sensitivity: "accent", ignorePunctuation: false });

export function sqlString(value: string | null | undefined) {
  return (value ?? "").replace(/ +$/g, "");
}

export function sqlEquals(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left == null || right == null) return left == null && right == null;
  return collator.compare(sqlString(left).toLocaleLowerCase("en-US"), sqlString(right).toLocaleLowerCase("en-US")) === 0;
}

export function sqlSort(left: string, right: string) {
  return collator.compare(left.toLocaleLowerCase("en-US"), right.toLocaleLowerCase("en-US"));
}

export function sqlLike(value: string | null | undefined, pattern: string): boolean {
  if (value == null) return false;
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i]!;
    if (character === "%") regex += ".*";
    else if (character === "_") regex += ".";
    else if (character === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) regex += "\\[";
      else {
        let body = pattern.slice(i + 1, end);
        if (body.startsWith("^")) body = `^${body.slice(1)}`;
        regex += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else regex += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  regex += "$";
  return new RegExp(regex, "i").test(value);
}

export function enforceNchar(value: string, width: number, label: string): string {
  if (value.length > width && value.slice(width).trim() !== "") throw new Error(`Legacy SQL fatal: truncation inserting ${label} into nchar(${width})`);
  return value.slice(0, width).padEnd(width, " ");
}

export function assertUnescapedSqlValue(value: string, label: string) {
  if (value.includes("'")) throw new Error(`Legacy SQL fatal at ${label}: unescaped apostrophe terminated the concatenated SQL statement`);
}
