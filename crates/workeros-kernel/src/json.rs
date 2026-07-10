//! A minimal JSON value parser — just enough to read `package.json` fields
//! (`main`/`module`/`type`/`exports`/`browser`) during ESM `node_modules`
//! resolution (see [`crate::resolver`]).
//!
//! The kernel is deliberately dependency-free (no `serde`), so this is a compact
//! recursive-descent parser over the subset of JSON that package manifests use.
//! Object key order is preserved because `exports` condition matching is
//! order-sensitive ("import" before "require" before "default").

/// A parsed JSON value.
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    /// Object, preserving insertion order.
    Obj(Vec<(String, Json)>),
}

impl Json {
    /// The string, if this value is a string.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    /// Look up a key, if this value is an object.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// True if this value is an object.
    pub fn is_object(&self) -> bool {
        matches!(self, Json::Obj(_))
    }

    /// Parse a complete JSON document. Returns `None` on any syntax error —
    /// resolution treats a malformed manifest as "no usable fields", not a crash.
    pub fn parse(src: &str) -> Option<Json> {
        let mut p = Parser { b: src.as_bytes(), i: 0 };
        p.ws();
        let v = p.value()?;
        p.ws();
        // Allow trailing whitespace only.
        if p.i == p.b.len() {
            Some(v)
        } else {
            None
        }
    }
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && self.b[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }

    fn value(&mut self) -> Option<Json> {
        self.ws();
        match self.b.get(self.i)? {
            b'"' => self.string().map(Json::Str),
            b'{' => self.object(),
            b'[' => self.array(),
            b't' => self.lit("true", Json::Bool(true)),
            b'f' => self.lit("false", Json::Bool(false)),
            b'n' => self.lit("null", Json::Null),
            _ => self.number(),
        }
    }

    fn lit(&mut self, word: &str, val: Json) -> Option<Json> {
        if self.b[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Some(val)
        } else {
            None
        }
    }

    fn string(&mut self) -> Option<String> {
        // Assumes current byte is the opening quote.
        self.i += 1;
        let mut out = String::new();
        while self.i < self.b.len() {
            let c = self.b[self.i];
            match c {
                b'"' => {
                    self.i += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.i += 1;
                    let e = *self.b.get(self.i)?;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'n' => out.push('\n'),
                        b't' => out.push('\t'),
                        b'r' => out.push('\r'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'u' => {
                            let hex = self.b.get(self.i + 1..self.i + 5)?;
                            let code = u32::from_str_radix(core::str::from_utf8(hex).ok()?, 16).ok()?;
                            out.push(char::from_u32(code)?);
                            self.i += 4;
                        }
                        _ => return None,
                    }
                    self.i += 1;
                }
                _ => {
                    // Copy the UTF-8 byte(s) through verbatim.
                    let start = self.i;
                    self.i += 1;
                    while self.i < self.b.len() && self.b[self.i] & 0xC0 == 0x80 {
                        self.i += 1;
                    }
                    out.push_str(core::str::from_utf8(&self.b[start..self.i]).ok()?);
                }
            }
        }
        None
    }

    fn number(&mut self) -> Option<Json> {
        let start = self.i;
        while self.i < self.b.len() {
            let c = self.b[self.i];
            if c.is_ascii_digit() || matches!(c, b'-' | b'+' | b'.' | b'e' | b'E') {
                self.i += 1;
            } else {
                break;
            }
        }
        core::str::from_utf8(&self.b[start..self.i])
            .ok()?
            .parse::<f64>()
            .ok()
            .map(Json::Num)
    }

    fn array(&mut self) -> Option<Json> {
        self.i += 1; // '['
        let mut items = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b']') {
            self.i += 1;
            return Some(Json::Arr(items));
        }
        loop {
            items.push(self.value()?);
            self.ws();
            match self.b.get(self.i)? {
                b',' => {
                    self.i += 1;
                }
                b']' => {
                    self.i += 1;
                    return Some(Json::Arr(items));
                }
                _ => return None,
            }
        }
    }

    fn object(&mut self) -> Option<Json> {
        self.i += 1; // '{'
        let mut pairs = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Some(Json::Obj(pairs));
        }
        loop {
            self.ws();
            if self.b.get(self.i)? != &b'"' {
                return None;
            }
            let key = self.string()?;
            self.ws();
            if self.b.get(self.i)? != &b':' {
                return None;
            }
            self.i += 1;
            let val = self.value()?;
            pairs.push((key, val));
            self.ws();
            match self.b.get(self.i)? {
                b',' => {
                    self.i += 1;
                }
                b'}' => {
                    self.i += 1;
                    return Some(Json::Obj(pairs));
                }
                _ => return None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_scalars_and_nesting() {
        assert_eq!(Json::parse("true"), Some(Json::Bool(true)));
        assert_eq!(Json::parse("  \"hi\" "), Some(Json::Str("hi".into())));
        assert_eq!(Json::parse("[1, 2]"), Some(Json::Arr(vec![Json::Num(1.0), Json::Num(2.0)])));
    }

    #[test]
    fn object_lookup_preserves_order() {
        let j = Json::parse(r#"{"import": "./e.mjs", "require": "./e.cjs", "default": "./e.js"}"#).unwrap();
        assert_eq!(j.get("import").and_then(Json::as_str), Some("./e.mjs"));
        if let Json::Obj(pairs) = &j {
            assert_eq!(pairs[0].0, "import");
            assert_eq!(pairs[2].0, "default");
        } else {
            panic!("expected object");
        }
    }

    #[test]
    fn string_escapes() {
        assert_eq!(Json::parse(r#""a\/b\n""#), Some(Json::Str("a/b\n".into())));
        assert_eq!(Json::parse(r#""A""#), Some(Json::Str("A".into())));
    }

    #[test]
    fn realistic_package_json() {
        let src = r#"{
            "name": "edge.js",
            "version": "6.0.0",
            "type": "module",
            "main": "build/index.js",
            "exports": {
                ".": { "import": "./build/index.js", "types": "./build/index.d.ts" },
                "./package.json": "./package.json"
            }
        }"#;
        let j = Json::parse(src).unwrap();
        assert_eq!(j.get("type").and_then(Json::as_str), Some("module"));
        assert_eq!(j.get("main").and_then(Json::as_str), Some("build/index.js"));
        let dot = j.get("exports").unwrap().get(".").unwrap();
        assert_eq!(dot.get("import").and_then(Json::as_str), Some("./build/index.js"));
    }

    #[test]
    fn malformed_is_none() {
        assert_eq!(Json::parse("{bad}"), None);
        assert_eq!(Json::parse("{\"a\": }"), None);
        assert_eq!(Json::parse("[1, 2"), None);
        assert_eq!(Json::parse("trailing garbage"), None);
    }
}
