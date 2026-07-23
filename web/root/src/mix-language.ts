import {
  defaultHighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
  type StreamParser,
  type StringStream,
} from "@codemirror/language";

type MixState = { blockComment: boolean };

const keywords = new Set(["if", "then", "else"]);

function blockComment(stream: StringStream, state: MixState) {
  while (!stream.eol()) {
    if (stream.match("*/")) {
      state.blockComment = false;
      break;
    }
    stream.next();
  }
  return "blockComment";
}

const parser: StreamParser<MixState> = {
  name: "mix",
  languageData: {
    commentTokens: { line: "#" },
  },
  startState: () => ({ blockComment: false }),
  token(stream, state) {
    if (state.blockComment) return blockComment(stream, state);
    if (stream.eatSpace()) return null;

    if (stream.match("#")) {
      stream.skipToEnd();
      return "lineComment";
    }
    if (stream.match("/*")) {
      state.blockComment = true;
      return blockComment(stream, state);
    }

    if (stream.peek() === '"') {
      stream.next();
      let escaped = false;
      while (!stream.eol()) {
        const char = stream.next();
        if (char === '"' && !escaped) break;
        escaped = char === "\\" && !escaped;
        if (char !== "\\") escaped = false;
      }
      return "string";
    }

    if (stream.match(/^(?:\d[\d_]*)(?:\.\d[\d_]*)?/)) return "number";

    if (stream.match(/^[A-Za-z_][A-Za-z0-9_']*/)) {
      const word = stream.current();
      if (keywords.has(word)) return "keyword";
      if (word === "true" || word === "false") return "bool";

      const rest = stream.string.slice(stream.pos);
      if (/^\s*=/.test(rest)) return "propertyName";
      if (/^\s*:/.test(rest)) return "variableName";
      return "variableName";
    }

    if (stream.match(/^(?:==|!=|>=|<=|->|::|\.\.|\|>|<\||&&|\|\||[+\-*\/%=<>!?:@$.])/)) {
      return "operator";
    }
    if (stream.match(/^[(){}\[\],;]/)) return "punctuation";

    stream.next();
    return "invalid";
  },
};

export const mixLanguage = [
  StreamLanguage.define(parser),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
];
