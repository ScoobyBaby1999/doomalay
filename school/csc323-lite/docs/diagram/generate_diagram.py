#!/usr/bin/env python3
"""
DCLbot UML class diagram generator - CODE-DERIVED (v2).

Unlike a hand-maintained spec, this script READS the C# sources under
src/DCLbot/ and derives every box and every arrow from the code itself:

  boxes   = every type found in the sources (classes / interfaces / enums,
            with the members exactly as declared)
  arrows  = derived from real code facts:
            base list            -> generalization (solid triangle)
            base interface       -> realization (dashed triangle)
            field/property type  -> association (solid, navigable) or
                                    composition (filled diamond, for
                                    collections and the owned Conversation)
            method param/return, "new X()", typeof(X), (X) cast, case X.,
            catch (X), Deserialize<X>(  -> dependency (dashed open arrow)

  so an arrow can never be inverted (whoever DECLARES the member owns the
  arrow) and can never dangle (both ends must exist).

Notation (course Ch.2/Ch.3 conventions, rendered by PlantUML):
  + public   - private   # protected   {internal} tag = internal
  underlined = static ({static})   {abstract} italic
  hollow triangle = inheritance   dashed triangle = realization
  filled diamond = composition (at the whole)   dashed open arrow = dependency

Usage:
  python3 generate_diagram.py --version 0.9.0 --src ../../src/DCLbot --outdir .

Output: class_diagram.puml / class_diagram.png / class_diagram.svg
(PlantUML is the UML tool; the .puml text is the editable source of truth -
the same role the StarUML / VS Class Designer file plays on Windows.)
"""
import argparse
import os
import re
import subprocess
import sys

# --------------------------------------------------------------------------
# palette (charts-skill compliant, low saturation)
# --------------------------------------------------------------------------
PAL = dict(
    text="#243447", muted="#64748B", edge="#475569",
    class_bg="#DBEAFE", class_border="#4C6EF5",
    iface_bg="#EDE9FE", iface_border="#6D28D9",
    abstract_bg="#FEF3C7", abstract_border="#B45309",
    enum_bg="#D1FAE5", enum_border="#0F766E",
    ext_bg="#F1F5F9", ext_border="#94A3B8",
    pkg_bg="#F8FAFC", pkg_border="#CBD5E1",
)

# --------------------------------------------------------------------------
# source parsing
# --------------------------------------------------------------------------

def mask_strings_and_comments(src):
    """Replace string/char literals with placeholders, then drop comments.
    Order matters: 'https://...' must not be treated as a comment."""
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c == '"':
            j = i + 1
            while j < n:
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == '"':
                    break
                j += 1
            out.append('"S"')
            i = j + 1
        elif src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j == -1 else j
        elif src.startswith("/*", i):
            j = src.find("*/", i)
            i = n if j == -1 else j + 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def match_brace(text, open_idx):
    depth = 0
    for k in range(open_idx, len(text)):
        if text[k] == '{':
            depth += 1
        elif text[k] == '}':
            depth -= 1
            if depth == 0:
                return k
    return len(text) - 1


TYPE_DECL_RE = re.compile(
    r"(?:(?:public|private|protected|internal|sealed|abstract|static|partial)\s+)*"
    r"(class|interface|enum)\s+(\w+)\s*(?::\s*([\w<>,\.\s]+?))?\s*\{")


def parse_sources(src_root):
    """Return {type_name: type_dict} merged across files (partial types)."""
    types = {}
    for dirpath, _dirs, files in os.walk(src_root):
        for fn in sorted(files):
            if not fn.endswith(".cs"):
                continue
            path = os.path.join(dirpath, fn)
            raw = open(path, encoding="utf-8-sig").read()
            clean = mask_strings_and_comments(raw)
            ns_match = re.search(r"\bnamespace\s+([\w\.]+)", clean)
            ns = ns_match.group(1) if ns_match else ""
            for m in TYPE_DECL_RE.finditer(clean):
                kind, name, bases = m.group(1), m.group(2), m.group(3) or ""
                body_open = clean.index("{", m.start())
                body_close = match_brace(clean, body_open)
                body = clean[body_open + 1:body_close]
                mods = re.findall(r"(abstract|static|sealed|partial|internal)",
                                  clean[max(0, m.start() - 80):m.end()])
                t = types.setdefault(name, dict(
                    name=name, ns=ns, kind=kind,
                    abstract="abstract" in mods, static="static" in mods,
                    bases=[], members=[], body=""))
                t["bases"] += [b.strip() for b in bases.split(",") if b.strip()]
                t["body"] += body
    return types


def split_members(body):
    """Split a type body into top-level member chunks (declaration + block)."""
    chunks, i, n, start = [], 0, len(body), 0
    while i < n:
        c = body[i]
        if c == '{':
            j = match_brace(body, i)
            chunks.append(body[start:j + 1])
            start = j + 1
            i = j + 1
        elif c == ';':
            chunks.append(body[start:i + 1])
            start = i + 1
            i += 1
        else:
            i += 1
    tail = body[start:].strip()
    if tail:
        chunks.append(tail)
    return chunks


VIS = r"(public|private|protected|internal)"
PROP_RE = re.compile(
    r"^\s*(?:" + VIS + r"\s+)?(?:static\s+)?"
    r"([\w<>,\.\s\?]+?)\s+(\w+)\s*\{\s*(?:get\b|})", re.S)
METHOD_RE = re.compile(
    r"^\s*(?:" + VIS + r"\s+)?((?:static\s+|async\s+)?(?:virtual\s+|override\s+|"
    r"abstract\s+|sealed\s+|partial\s+)*)(?:async\s+)?"
    r"([\w<>\.,\s\?\[\]]+?)\s+(\w+)\s*\(([^)]*)\)", re.S)
CTOR_RE = re.compile(
    r"^\s*(?:" + VIS + r"\s+)?((?:static\s+)*)(\w+)\s*\(([^)]*)\)", re.S)
FIELD_RE = re.compile(
    r"^\s*(?:" + VIS + r"\s+)?(?:static\s+)?(?:readonly\s+)?"
    r"([\w<>,\.\s\?]+?)\s+(\w+)\s*(?:=[^;]*)?;\s*$", re.S)
ATTR_RE = re.compile(r"^\s*(?:\[[^\]]*\]\s*)+")


def parse_member(chunk, type_name, is_interface):
    """Classify one top-level chunk into a member dict (or None)."""
    chunk = ATTR_RE.sub("", chunk)
    chunk = chunk.strip()
    if not chunk:
        return None

    # ---- property (vis Type Name { get ... }) ----------------------------
    pm = PROP_RE.match(chunk)
    if pm:
        vis = pm.group(1) or "private"
        readonly = ("set" not in chunk) or bool(re.search(r"private\s+set", chunk))
        tags = ["readonly"] if readonly else []
        static = "static" in chunk.split("{")[0]
        return dict(kind="prop", vis=vis, static=static,
                    typ=pm.group(2).strip(), name=pm.group(3), tags=tags)

    # ---- method / constructor -------------------------------------------
    head = chunk.split("{")[0]
    cm = CTOR_RE.match(chunk) if "(" in head else None
    mm = METHOD_RE.match(chunk)
    if cm and (mm is None or cm.group(3) == type_name):
        # constructor: 'Vis Name(...)' with NO return type; METHOD_RE would
        # mis-split 'Name(' into a fake ret/name pair, so handle it first
        vis = cm.group(1) or "private"
        static = bool(cm.group(2).strip())
        params = cm.group(4)
        tags = ["internal"] if vis == "internal" else []
        return dict(kind="method", vis=vis, static=static, ret="",
                    name=type_name, params=params, tags=tags)
    if mm:
        vis = mm.group(1) or "private"
        qual = mm.group(2)
        ret = mm.group(3).strip()
        name = mm.group(4)
        params = mm.group(5)
        static = "static" in chunk.split("(")[0]
        tags = []
        for q in ("virtual", "override", "abstract", "sealed"):
            if q in qual:
                tags.append(q)
        if vis == "internal":
            tags.append("internal")
        if is_interface:
            vis, static, tags = "+", False, ["abstract"]
        return dict(kind="method", vis=vis, static=static, ret=ret,
                    name=name, params=params, tags=tags)

    # ---- field -----------------------------------------------------------
    if is_interface:
        return None
    fm = FIELD_RE.match(chunk)
    if fm and "{" not in chunk.split("=")[0]:
        vis = fm.group(1) or "private"
        return dict(kind="field", vis=vis, static="static " in chunk,
                    typ=fm.group(2).strip(), name=fm.group(3),
                    readonly="readonly" in chunk, tags=[])
    return None


def extract_members(t):
    if t["kind"] == "enum":
        vals = []
        for line in t["body"].split(","):
            v = line.strip().rstrip(",")
            if re.fullmatch(r"\w+", v or ""):
                vals.append(v)
        t["members"] = [dict(kind="enumval", name=v) for v in vals]
        return
    members = []
    for chunk in split_members(t["body"]):
        mem = parse_member(chunk, t["name"], t["kind"] == "interface")
        if mem:
            members.append(mem)
    t["members"] = members


def simple_type(decl):
    """'List<ChatMessage>' -> 'ChatMessage'; 'Providers.Dto.Choice' -> 'Choice'."""
    decl = decl.strip()
    m = re.fullmatch(r"[\w\.]+<(.+)>", decl)
    if m:
        return m.group(1).strip()
    return decl.split(".")[-1]


USAGE_PATTERNS = (
    r"new\s+([\w\.]+)\s*[\({]",          # creation
    r"typeof\(\s*([\w\.]+)\s*\)",        # typeof(X)
    r"\(\s*([\w\.]+)\s*\)[\.\w]",        # (X) cast followed by member access
    r"\bas\s+([\w\.]+)\b",               # x as X
    r"case\s+([\w\.]+)\.",               # switch label X.Y
    r"catch\s*\(\s*([\w\.]+)\s",         # catch (X ex)
    r"<\s*([\w\.]+)\s*>\s*\(",           # M<X>(...) generic argument
    r"\b([A-Z]\w+)\s*\.\s*\w+\s*\(",    # static call X.Method(...)
)


def collect_usages(t, known):
    hits = set()
    for pat in USAGE_PATTERNS:
        for m in re.finditer(pat, t["body"]):
            name = simple_type(m.group(1))
            if name in known and name != t["name"]:
                hits.add(name)
    return hits


# --------------------------------------------------------------------------
# relationship derivation
# --------------------------------------------------------------------------

# Course verb vocabulary for the dependency edges (src, dst) -> label.
DEP_LABELS = {
    ("Program", "frmChat"): "creates",
    ("ChatService", "ProviderFactory"): "creates",
    ("ChatService", "ProviderKind"): "switches on",
    ("ChatService", "ChatReply"): "returns",
    ("ChatService", "ProviderException"): "throws",
    ("ProviderFactory", "IChatProvider"): "creates",
    ("ProviderFactory", "ProviderKind"): "reads",
    ("ProviderFactory", "ProviderException"): "throws",
    ("ChatProviderBase", "ProviderException"): "throws",
    ("OpenRouterProvider", "ChatCompletionRequest"): "builds",
    ("OpenRouterProvider", "ChatCompletionResponse"): "reads",
    ("OpenRouterProvider", "RequestMessage"): "creates",
    ("OpenRouterProvider", "ChatRole"): "maps",
    ("OpenRouterProvider", "ProviderException"): "throws",
    ("EchoProvider", "TextUtils"): "uses",
    ("OpenRouterProvider", "TextUtils"): "uses",
    ("IChatProvider", "ChatMessage"): "receives",
    ("IChatProvider", "ChatReply"): "returns",
    ("frmChat", "ProviderException"): "catches",
}


def derive(types, known):
    edges = []

    def add(kind, src, dst, label=None, msrc=None, mdst=None):
        edges.append(dict(kind=kind, src=src, dst=dst, label=label,
                          msrc=msrc, mdst=mdst))

    # R1: inheritance / realization from base lists
    for t in types.values():
        for b in t["bases"]:
            b_simple = simple_type(b)
            if b_simple == "Exception":
                add("gen", t["name"], "Exception")
                continue
            if b_simple not in known:
                continue
            if types[b_simple]["kind"] == "interface":
                add("real", t["name"], b_simple)
            else:
                add("gen", t["name"], b_simple)

    # R2: fields / properties -> association or composition
    ASSOC_VERBS = {
        ("ChatService", "IChatProvider"): "sends via",
        ("ChatService", "IProviderInfo"): "gets status",
        ("ChatService", "ApiSettings"): "sets",
        ("ChatProviderBase", "ApiSettings"): "reads",
        ("ProviderFactory", "ApiSettings"): "reads",
        ("ChatMessage", "ChatRole"): "is",
        ("frmChat", "ChatService"): "uses",
        ("Choice", "RequestMessage"): "has",
    }
    for t in types.values():
        for mem in t["members"]:
            if mem.get("kind") not in ("field", "prop"):
                continue
            decl = mem["typ"]
            target = simple_type(decl)
            if target not in known or target == t["name"]:
                continue
            is_collection = bool(re.search(r"<\s*" + re.escape(target), decl))
            exclusively_owned = (target == "Conversation")
            if is_collection or exclusively_owned:
                add("comp", t["name"], target, "holds", msrc="1", mdst="0..*")
            else:
                verb = ASSOC_VERBS.get((t["name"], target), "uses")
                add("assoc", t["name"], target, verb)

    # R3: dependency from signatures (params / returns) and usages
    for t in types.values():
        sig_types = set()
        for mem in t["members"]:
            if mem.get("kind") != "method":
                continue
            if mem["params"].strip():
                for piece in mem["params"].split(","):
                    toks = piece.strip().split()
                    if toks:
                        sig_types.add(simple_type(toks[0]))
            if mem["ret"] and mem["ret"] != "void":
                sig_types.add(simple_type(mem["ret"]))
        targets = sig_types | collect_usages(t, known)
        for target in sorted(targets):
            if target == t["name"] or target not in known:
                continue
            if target in ("string", "int", "double", "bool", "void", "object"):
                continue
            label = DEP_LABELS.get((t["name"], target), "uses")
            if target == "ChatReply" and \
                    (t["name"], target) not in DEP_LABELS:
                label = "returns"
            add("dep", t["name"], target, label)
    return edges


def prune(types, edges):
    """Remove redundant dependency edges, each for a documented reason."""
    stronger = {(e["src"], e["dst"]) for e in edges
                if e["kind"] in ("assoc", "comp", "gen", "real")}
    dep_pairs = {(e["src"], e["dst"]) for e in edges if e["kind"] == "dep"}

    # ancestors via generalization/realization (transitive)
    parents = {}
    for e in edges:
        if e["kind"] in ("gen", "real"):
            parents.setdefault(e["src"], set()).add(e["dst"])

    def ancestors(n, seen=None):
        seen = seen or set()
        for p in parents.get(n, ()):
            if p not in seen:
                seen.add(p)
                ancestors(p, seen)
        return seen

    out, seen = [], set()
    for e in edges:
        key = (e["kind"], e["src"], e["dst"])
        if key in seen:
            continue
        seen.add(key)
        if e["kind"] == "dep":
            src, dst = e["src"], e["dst"]
            # (a) a stronger edge (assoc/comp/gen/real) already shows it
            if (src, dst) in stronger:
                continue
            # (b) an ancestor already declares the same dependency or a
            #     stronger edge to dst (the contract carries the fact)
            if any((a, dst) in dep_pairs or (a, dst) in stronger
                   for a in ancestors(src)):
                continue
            # (c) factory -> concrete providers: the factory's contract edge
            #     ProviderFactory ..> IChatProvider shows the pattern; the
            #     concrete wiring is visible in the inheritance tree
            if src == "ProviderFactory" and dst in ("EchoProvider",
                                                    "OpenRouterProvider"):
                continue
            # (d) ChatService -> ChatMessage: flows through Conversation
            if src == "ChatService" and dst == "ChatMessage":
                continue
            # (e) providers creating ChatReply: IChatProvider ..> ChatReply
            #     already documents the return flow
            if src in ("EchoProvider", "OpenRouterProvider",
                       "ChatProviderBase") and dst == "ChatReply":
                continue
        out.append(e)
    return out


# --------------------------------------------------------------------------
# PlantUML emission
# --------------------------------------------------------------------------

def plantuml_type(t):
    """Strip namespace prefixes; keep generics as raw <T> (renders fine)."""
    t = t.strip()
    t = re.sub(r"[A-Za-z_][\w]*\.<", "<", t)
    t = re.sub(r"<([\w\.,\s]+)>",
               lambda m: "<" + ", ".join(
                   p.strip().split(".")[-1] for p in m.group(1).split(",")
               ) + ">", t)
    return t


def fmt_params(params):
    out = []
    for piece in params.split(","):
        piece = piece.strip()
        if not piece:
            continue
        toks = piece.split()
        if len(toks) >= 2:
            out.append(toks[-1] + " : " + plantuml_type(" ".join(toks[:-1])))
        else:
            out.append(plantuml_type(toks[0]))
    return ", ".join(out)


def member_line(mem, type_name):
    if mem.get("kind") == "enumval":
        return mem["name"]
    vis = {"public": "+", "private": "-", "protected": "#",
           "internal": "-"}.get(mem.get("vis", "-"), "-")
    tags = [t for t in mem.get("tags", [])
            if t in ("override", "virtual", "readonly", "internal", "sealed")]
    if "abstract" in mem.get("tags", []):
        tags = ["abstract"] + tags
    body = ""
    if mem["kind"] == "field":
        body = plantuml_type(mem["typ"]) + " " + mem["name"]
    elif mem["kind"] == "prop":
        body = plantuml_type(mem["typ"]) + " " + mem["name"]
    else:
        is_ctor = (mem["name"] == type_name)
        body = mem["name"] + "(" + fmt_params(mem.get("params", "")) + ")"
        ret = mem.get("ret", "")
        if ret and ret != "void" and not is_ctor:
            body += " : " + plantuml_type(ret)
    tag_txt = "".join(" {" + t + "}" for t in tags)
    static_txt = "{static} " if mem.get("static") else ""
    return vis + " " + static_txt + body + tag_txt


def class_block(t):
    if t["kind"] == "enum":
        kw = "enum"
    elif t["abstract"]:
        kw = "abstract class"
    elif t["kind"] == "interface":
        kw = "interface"
    else:
        kw = "class"
    lines = [kw + " " + t["name"] + " {"]
    for mem in t["members"]:
        lines.append("    " + member_line(mem, t["name"]))
    lines.append("  }")
    return "\n".join(lines)


ARROW = dict(gen=" --|> ", real=" ..|> ", comp=" *-- ",
             assoc=" --> ", dep=" ..> ")


def edge_line(e):
    line = e["src"]
    if e.get("msrc"):
        line += ' "%s"' % e["msrc"]
    # inheritance/realization: put the PARENT first so it renders ABOVE the
    # child (course convention: children sit below the parent, triangle up)
    if e["kind"] == "gen":
        line = e["dst"] + " <|-- " + e["src"]
        return line
    if e["kind"] == "real":
        line = e["dst"] + " <|.. " + e["src"]
        return line
    line += ARROW[e["kind"]]
    if e.get("mdst"):
        line += '"%s" ' % e["mdst"]
    line += e["dst"]
    if e.get("label"):
        line += " : " + e["label"]
    return line


ORDER = ["ChatRole", "ChatMessage", "Conversation", "ApiSettings",
         "ChatReply", "IChatProvider", "IProviderInfo", "ChatProviderBase",
         "ProviderKind", "ProviderFactory", "ProviderException",
         "EchoProvider", "OpenRouterProvider", "TextUtils",
         "ChatCompletionRequest", "RequestMessage", "ChatCompletionResponse",
         "Choice", "ChatService", "frmChat", "Program"]


def generate_puml(types, edges, version):
    ns_groups = {}
    for n, t in types.items():
        ns_groups.setdefault(t["ns"], []).append(n)

    L = []
    L.append("@startuml class_diagram")
    L.append("title DCLbot class diagram v%s - generated from the C# source"
             % version)
    L.append("skinparam dpi 130")
    L.append("skinparam backgroundColor white")
    L.append("skinparam linetype ortho")
    L.append("skinparam classAttributeIconSize 0")
    L.append("skinparam defaultFontName DejaVu Sans")
    L.append("skinparam shadowing false")
    L.append("skinparam class {")
    L.append("  BackgroundColor %s" % PAL["class_bg"])
    L.append("  BorderColor %s" % PAL["class_border"])
    L.append("  ArrowColor %s" % PAL["edge"])
    L.append("  FontColor %s" % PAL["text"])
    L.append("}")
    L.append("skinparam interface {")
    L.append("  BackgroundColor %s" % PAL["iface_bg"])
    L.append("  BorderColor %s" % PAL["iface_border"])
    L.append("}")
    L.append("skinparam enum {")
    L.append("  BackgroundColor %s" % PAL["enum_bg"])
    L.append("  BorderColor %s" % PAL["enum_border"])
    L.append("}")
    L.append("skinparam abstract {")
    L.append("  BackgroundColor %s" % PAL["abstract_bg"])
    L.append("  BorderColor %s" % PAL["abstract_border"])
    L.append("}")
    L.append("skinparam package {")
    L.append("  BackgroundColor %s" % PAL["pkg_bg"])
    L.append("  BorderColor %s" % PAL["pkg_border"])
    L.append("  FontColor %s" % PAL["muted"])
    L.append("  FontStyle bold")
    L.append("}")
    L.append("skinparam legend {")
    L.append("  BackgroundColor %s" % PAL["pkg_bg"])
    L.append("  BorderColor %s" % PAL["ext_border"])
    L.append("  FontColor %s" % PAL["text"])
    L.append("}")
    L.append("")
    L.append('class "Exception" as Exception <<external>> #%s;line:%s'
             % (PAL["ext_bg"][1:], PAL["ext_border"][1:]))
    L.append("")
    for ns in sorted(ns_groups):
        L.append('package "%s" {' % ns)
        members = sorted(ns_groups[ns],
                         key=lambda n: ORDER.index(n) if n in ORDER else 99)
        for n in members:
            L.append("  " + class_block(types[n]).replace("\n", "\n  "))
        L.append("}")
        L.append("")
    L.append("' --- relationships (all derived from the source) ---")
    for e in edges:
        L.append(edge_line(e))
    L.append("")
    L.append("legend right")
    L.append("  + public   - private   # protected   underlined = static")
    L.append("  {abstract} {override} {virtual} {readonly} {internal} tags")
    L.append("  hollow triangle = inheritance   dashed triangle = realization")
    L.append("  filled diamond = composition (at the whole)")
    L.append("  dashed open arrow = dependency (uses / creates / returns)")
    L.append("  solid arrow = association, navigable as drawn")
    L.append("end legend")
    L.append("@enduml")
    return "\n".join(L) + "\n"


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="0.9.0")
    ap.add_argument("--src", default=os.path.join(os.path.dirname(__file__),
                                                  "..", "..", "src", "DCLbot"))
    ap.add_argument("--outdir", default=os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--plantuml-jar", default=os.environ.get(
        "PLANTUML_JAR", "plantuml.jar"))
    ap.add_argument("--dot-source", action="store_true",
                    help="print the derived edge list and exit")
    args = ap.parse_args()

    types = parse_sources(os.path.abspath(args.src))
    for t in types.values():
        extract_members(t)
    known = set(types)

    edges = derive(types, known)
    edges = prune(types, edges)

    if args.dot_source:
        for e in edges:
            print("%-6s %-24s %-6s %-24s %s" %
                  (e["kind"], e["src"], "-->", e["dst"], e["label"] or ""))
        return 0

    puml = generate_puml(types, edges, args.version)
    base = os.path.join(args.outdir, "class_diagram")
    with open(base + ".puml", "w", encoding="utf-8") as f:
        f.write(puml)

    print("%d types, %d edges after prune" % (len(types), len(edges)))
    env = dict(os.environ, PLANTUML_LIMIT_SIZE="16384")
    subprocess.run(["java", "-DPLANTUML_LIMIT_SIZE=16384", "-jar",
                    args.plantuml_jar, "-tpng", base + ".puml", "-o", "."],
                   check=True, env=env)
    subprocess.run(["java", "-jar", args.plantuml_jar,
                    "-tsvg", base + ".puml", "-o", "."], check=True)
    print("rendered", base + ".png / .svg / .puml")
    return 0


if __name__ == "__main__":
    sys.exit(main())
