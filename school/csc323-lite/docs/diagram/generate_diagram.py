#!/usr/bin/env python3
"""
DoomalayLite UML class diagram generator.

Single source of truth: the CLASSES / RELATIONS spec below carries a "since"
version per element. Rendering a given version shows exactly the types that
exist in the codebase at that version - so the diagram in git evolves with
every versioned push.

  python3 generate_diagram.py --version 0.2.0 --outdir .

Output: class_diagram.dot / class_diagram.png / class_diagram.svg

Notation legend (rendered into the image):
  + public   - private   # protected   underlined = static (course Ch.2)
  {abstract} {override} {virtual} {readonly} tags; italic = abstract/interface.
  Generalization: hollow triangle. Realization: dashed hollow triangle.
  Composition: filled diamond at the WHOLE. Dependency: dashed open arrow.
"""
import argparse
import html
import subprocess
import os

# --- low-saturation palette (skill-compliant) --------------------------------
C = dict(
    class_bg="#DBEAFE", class_border="#4C6EF5",
    iface_bg="#EDE9FE", iface_border="#6D28D9",
    abstract_bg="#FEF3C7", abstract_border="#B45309",
    enum_bg="#D1FAE5", enum_border="#0F766E",
    external_bg="#F1F5F9", external_border="#94A3B8",
    attr_bg="#FFFFFF", method_bg="#F8FAFC",
    text="#243447", muted="#64748B", edge="#475569",
)

# --- class spec ----------------------------------------------------------------
# attrs: list of (vis, static, text)      text like "_messages : List<ChatMessage> {readonly}"
# methods: list of (vis, static, text)    text like "Send(messages : IReadOnlyList<ChatMessage>) : ChatReply {abstract}"
# enum values ride in attrs with vis="" e.g. ("", False, "System")
CLASSES = [
    # ------------- Core (v0.2.0) -------------
    dict(name="ChatRole", ns="DoomalayLite.Core", kind="enum", since="0.2.0",
         attrs=[("", False, "System"), ("", False, "User"), ("", False, "Assistant")], methods=[]),
    dict(name="ChatMessage", ns="DoomalayLite.Core", kind="class", since="0.2.0",
         attrs=[("-", False, "_createdAt : DateTime"),
                ("+", False, "Role : ChatRole {readonly}"),
                ("+", False, "Content : string"),
                ("+", False, "CreatedAt : DateTime {readonly}")],
         methods=[("+", False, "ChatMessage(content : string)"),
                  ("+", False, "ChatMessage(role : ChatRole, content : string)"),
                  ("+", False, "ToString() : string {override}")]),
    dict(name="Conversation", ns="DoomalayLite.Core", kind="class", since="0.2.0",
         attrs=[("-", False, "_messages : List<ChatMessage>"),
                ("-", False, "_maxMessages : int"),
                ("+", False, "Count : int {readonly}"),
                ("+", False, "MaxMessages : int {readonly}"),
                ("+", False, "Messages : IReadOnlyList<ChatMessage> {readonly}")],
         methods=[("+", False, "Conversation()"),
                  ("+", False, "Conversation(maxMessages : int)"),
                  ("+", False, "Add(message : ChatMessage) : void"),
                  ("+", False, "AddUserMessage(content : string) : void"),
                  ("+", False, "AddAssistantMessage(content : string) : void"),
                  ("+", False, "Clear() : void"),
                  ("+", False, "Render() : string"),
                  ("-", False, "Trim() : void")]),
    dict(name="ApiSettings", ns="DoomalayLite.Core", kind="class", since="0.2.0",
         attrs=[("+", False, "EndpointUrl : string"),
                ("+", False, "ModelName : string"),
                ("+", False, "ApiKey : string"),
                ("+", False, "TimeoutSeconds : int"),
                ("+", False, "SystemPrompt : string")],
         methods=[("+", False, "ApiSettings()"),
                  ("+", False, "ApiSettings(apiKey : string)"),
                  ("+", False, "ApiSettings(apiKey : string, modelName : string)")]),
    dict(name="ChatReply", ns="DoomalayLite.Core", kind="class", since="0.2.0",
         attrs=[("+", False, "Content : string"),
                ("+", False, "ModelUsed : string"),
                ("+", False, "ElapsedSeconds : double")],
         methods=[("+", False, "ChatReply(content : string, modelUsed : string)"),
                  ("+", False, "ChatReply(content : string, modelUsed : string, elapsedSeconds : double)"),
                  ("+", False, "ToString() : string {override}")]),
    # ------------- Providers (v0.3.0) -------------
    dict(name="IChatProvider", ns="DoomalayLite.Providers", kind="interface", since="0.3.0",
         attrs=[],
         methods=[("+", False, "Send(messages : IReadOnlyList<ChatMessage>) : ChatReply {abstract}")]),
    dict(name="IProviderInfo", ns="DoomalayLite.Providers", kind="interface", since="0.3.0",
         attrs=[],
         methods=[("+", False, "DisplayName : string {abstract}"),
                  ("+", False, "IsReady : bool {abstract}")]),
    dict(name="ChatProviderBase", ns="DoomalayLite.Providers", kind="abstract", since="0.3.0",
         attrs=[("#", False, "Settings : ApiSettings {readonly}"),
                ("+", False, "DisplayName : string {readonly}"),
                ("+", False, "IsReady : bool {readonly}")],
         methods=[("+", False, "ChatProviderBase(settings : ApiSettings)"),
                  ("+", False, "Send(messages : IReadOnlyList<ChatMessage>) : ChatReply"),
                  ("#", False, "DoSend(messages : IReadOnlyList<ChatMessage>) : ChatReply {abstract}"),
                  ("#", False, "GetDisplayName() : string {abstract}"),
                  ("#", False, "ValidateSettings() : bool {virtual}")]),
    dict(name="ProviderKind", ns="DoomalayLite.Providers", kind="enum", since="0.3.0",
         attrs=[("", False, "OpenRouter"), ("", False, "Echo")], methods=[]),
    dict(name="ProviderFactory", ns="DoomalayLite.Providers", kind="class", since="0.3.0",
         attrs=[("-", False, "_settings : ApiSettings")],
         methods=[("+", False, "ProviderFactory(settings : ApiSettings)"),
                  ("+", False, "Create(kind : ProviderKind) : IChatProvider")]),
    dict(name="ProviderException", ns="DoomalayLite.Providers", kind="class", since="0.3.0",
         attrs=[],
         methods=[("+", False, "ProviderException(message : string)"),
                  ("+", False, "ProviderException(message : string, inner : Exception)")]),
    dict(name="EchoProvider", ns="DoomalayLite.Providers", kind="class", since="0.3.0",
         attrs=[("-", False, "_random : Random")],
         methods=[("+", False, "EchoProvider(settings : ApiSettings)"),
                  ("#", False, "GetDisplayName() : string {override}"),
                  ("#", False, "ValidateSettings() : bool {override}"),
                  ("#", False, "DoSend(messages : IReadOnlyList<ChatMessage>) : ChatReply {override}"),
                  ("-", False, "PickReply(input : string) : string"),
                  ("-", True, "CountWords(text : string) : int")]),
    # ------------- Providers / OpenRouter + DTOs (v0.4.0) -------------
    dict(name="OpenRouterProvider", ns="DoomalayLite.Providers", kind="class", since="0.4.0",
         attrs=[("-", False, "_http : HttpClient"),
                ("-", True, "ReadOptions : JsonSerializerOptions"),
                ("-", True, "WriteOptions : JsonSerializerOptions")],
         methods=[("+", False, "OpenRouterProvider(settings : ApiSettings)"),
                  ("#", False, "GetDisplayName() : string {override}"),
                  ("#", False, "ValidateSettings() : bool {override}"),
                  ("#", False, "DoSend(messages : IReadOnlyList<ChatMessage>) : ChatReply {override}"),
                  ("-", False, "BuildRequest(messages : IReadOnlyList<ChatMessage>) : ChatCompletionRequest"),
                  ("-", False, "Post(request : ChatCompletionRequest) : string"),
                  ("-", True, "ParseResponse(json : string) : ChatReply {internal}"),
                  ("-", True, "MapMessages(messages : IReadOnlyList<ChatMessage>) : List<RequestMessage> {internal}")]),
    dict(name="TextUtils", ns="DoomalayLite.Providers", kind="class", since="0.4.0",
         attrs=[],
         methods=[("+", True, "Truncate(text : string, max : int) : string")]),
    dict(name="ChatCompletionRequest", ns="DoomalayLite.Providers.Dto", kind="class", since="0.4.0",
         attrs=[("+", False, "Model : string"),
                ("+", False, "Messages : List<RequestMessage>")],
         methods=[]),
    dict(name="RequestMessage", ns="DoomalayLite.Providers.Dto", kind="class", since="0.4.0",
         attrs=[("+", False, "Role : string"),
                ("+", False, "Content : string"),
                ("+", False, "Reasoning : string")],
         methods=[]),
    dict(name="ChatCompletionResponse", ns="DoomalayLite.Providers.Dto", kind="class", since="0.4.0",
         attrs=[("+", False, "Id : string"),
                ("+", False, "Model : string"),
                ("+", False, "Choices : List<Choice>")],
         methods=[]),
    dict(name="Choice", ns="DoomalayLite.Providers.Dto", kind="class", since="0.4.0",
         attrs=[("+", False, "Index : int"),
                ("+", False, "Message : RequestMessage"),
                ("+", False, "FinishReason : string")],
         methods=[]),
    # ------------- Services (v0.5.0) -------------
    dict(name="ChatService", ns="DoomalayLite.Services", kind="class", since="0.5.0",
         attrs=[("-", True, "_instance : ChatService"),
                ("-", True, "_lock : object"),
                ("-", False, "_conversation : Conversation"),
                ("-", False, "_provider : IChatProvider"),
                ("-", False, "_providerInfo : IProviderInfo"),
                ("-", False, "_settings : ApiSettings"),
                ("+", False, "History : Conversation {readonly}"),
                ("+", False, "ProviderName : string {readonly}"),
                ("+", False, "ProviderReady : bool {readonly}"),
                ("+", False, "ModelName : string {readonly}")],
         methods=[("-", False, "ChatService()"),
                  ("+", True, "GetInstance() : ChatService"),
                  ("+", False, "SendUserMessage(text : string) : ChatReply"),
                  ("+", False, "SwitchProvider(kind : ProviderKind) : void"),
                  ("+", False, "Reset() : void"),
                  ("-", False, "SeedSystemPrompt() : void"),
                  ("-", True, "LoadApiKey() : string")]),
    # ------------- UI (v0.1.0 scaffold, full in v0.6.0) -------------
    dict(name="Program", ns="DoomalayLite", kind="class", since="0.1.0",
         attrs=[],
         methods=[("-", True, "Main(args : string[]) : void")]),
    dict(name="frmChat", ns="DoomalayLite.UI", kind="class", since="0.6.0",
         attrs=[("-", False, "_chat : ChatService"),
                ("-", False, "_busy : bool"),
                ("-", False, "_switchingProvider : bool"),
                ("-", False, "components : IContainer"),
                ("-", False, "panelTop : Panel"),
                ("-", False, "panelBottom : Panel"),
                ("-", False, "cboProvider : ComboBox"),
                ("-", False, "lblProvider : Label"),
                ("-", False, "btnSend : Button"),
                ("-", False, "btnClear : Button"),
                ("-", False, "txtInput : TextBox"),
                ("-", False, "txtChat : TextBox"),
                ("-", False, "statusStrip : StatusStrip"),
                ("-", False, "status : ToolStripStatusLabel")],
         methods=[("+", False, "frmChat()"),
                  ("-", False, "btnSend_Click(sender : object, e : EventArgs) : void"),
                  ("-", False, "btnClear_Click(sender : object, e : EventArgs) : void"),
                  ("-", False, "cboProvider_SelectedIndexChanged(sender : object, e : EventArgs) : void"),
                  ("-", False, "txtInput_KeyDown(sender : object, e : KeyEventArgs) : void"),
                  ("-", False, "RefreshTranscript() : void"),
                  ("-", False, "AppendLine(text : string) : void"),
                  ("-", False, "SetBusy(busy : bool) : void"),
                  ("-", False, "UpdateProviderStatus() : void")]),
    # ------------- external .NET surface -------------
    dict(name="Exception", ns="System", kind="external", since="0.3.0", attrs=[], methods=[]),
]

# --- relationship spec ---------------------------------------------------------
# kind: generalization | realization | composition | association | dependency
RELATIONS = [
    dict(kind="composition", src="ChatMessage", dst="Conversation", label="messages", srcm="1..*", dstm="1", since="0.2.0"),
    dict(kind="association", src="ChatMessage", dst="ChatRole", label="role", srcm="", dstm="1", since="0.2.0"),
    dict(kind="association", src="Conversation", dst="ChatMessage", label="creates", srcm="1", dstm="1..*", since="0.2.0", style="dashed"),

    dict(kind="realization", src="ChatProviderBase", dst="IChatProvider", since="0.3.0"),
    dict(kind="realization", src="ChatProviderBase", dst="IProviderInfo", since="0.3.0"),
    dict(kind="generalization", src="EchoProvider", dst="ChatProviderBase", since="0.3.0"),
    dict(kind="generalization", src="ProviderException", dst="Exception", since="0.3.0"),
    dict(kind="association", src="ProviderFactory", dst="IChatProvider", label="«create»", srcm="", dstm="1..*", since="0.3.0", style="dashed"),
    dict(kind="association", src="ProviderFactory", dst="ApiSettings", label="_settings", srcm="1", dstm="1", since="0.3.0"),
    dict(kind="association", src="ChatProviderBase", dst="ApiSettings", label="Settings", srcm="1..*", dstm="1", since="0.3.0"),

    dict(kind="generalization", src="OpenRouterProvider", dst="ChatProviderBase", since="0.4.0"),
    dict(kind="dependency", src="OpenRouterProvider", dst="ChatCompletionRequest", label="«create»", since="0.4.0"),
    dict(kind="dependency", src="OpenRouterProvider", dst="ChatCompletionResponse", label="«reads»", since="0.4.0"),
    dict(kind="composition", src="RequestMessage", dst="ChatCompletionRequest", label="messages", srcm="1..*", dstm="1", since="0.4.0"),
    dict(kind="composition", src="Choice", dst="ChatCompletionResponse", label="choices", srcm="1..*", dstm="1", since="0.4.0"),
    dict(kind="association", src="Choice", dst="RequestMessage", label="message", srcm="1", dstm="1", since="0.4.0"),
    dict(kind="dependency", src="OpenRouterProvider", dst="RequestMessage", label="«create»", since="0.4.0"),
    dict(kind="dependency", src="OpenRouterProvider", dst="TextUtils", label="«uses»", since="0.4.0"),
    dict(kind="dependency", src="EchoProvider", dst="TextUtils", label="«uses»", since="0.4.0"),

    dict(kind="composition", src="Conversation", dst="ChatService", label="_conversation", srcm="1", dstm="1", since="0.5.0"),
    dict(kind="association", src="ChatService", dst="IChatProvider", label="_provider", srcm="1", dstm="1", since="0.5.0"),
    dict(kind="association", src="ChatService", dst="IProviderInfo", label="_providerInfo", srcm="1", dstm="1", since="0.5.0", style="dashed"),
    dict(kind="association", src="ChatService", dst="ApiSettings", label="_settings", srcm="1", dstm="1", since="0.5.0"),
    dict(kind="dependency", src="ChatService", dst="ProviderFactory", label="«create»", since="0.5.0"),
    dict(kind="dependency", src="ChatService", dst="ChatReply", label="«create»", since="0.5.0"),

    dict(kind="association", src="frmChat", dst="ChatService", label="_chat", srcm="1", dstm="1", since="0.6.0"),
    dict(kind="dependency", src="frmChat", dst="ProviderKind", label="«uses»", since="0.6.0"),
    dict(kind="dependency", src="Program", dst="frmChat", label="«create»", since="0.6.0"),
]

KIND_STYLE = dict(
    **{"class": dict(header=C["class_bg"], border=C["class_border"], stereo=None, italic=False)},
    interface=dict(header=C["iface_bg"], border=C["iface_border"], stereo="interface", italic=True),
    abstract=dict(header=C["abstract_bg"], border=C["abstract_border"], stereo="abstract", italic=True),
    enum=dict(header=C["enum_bg"], border=C["enum_border"], stereo="enumeration", italic=False),
    external=dict(header=C["external_bg"], border=C["external_border"], stereo=None, italic=True),
)

VIS_CHAR = {"+": "+", "-": "-", "#": "#"}


def esc(s):
    return html.escape(s, quote=True)


def member_line(vis, static, text):
    """Course Ch.2 notation: +/#/- visibility, STATIC members are UNDERLINED."""
    prefix = ""
    if vis:
        prefix += VIS_CHAR[vis] + " "
    body = esc(prefix + text)
    return f"<U>{body}</U>" if static else body


def class_node(cls):
    style = KIND_STYLE[cls["kind"]]
    border = f'COLOR="{style["border"]}" BORDER="2"'
    name_font = 'FACE="DejaVu Sans" POINT-SIZE="13"'
    stereo = style["stereo"]
    name_html = f"<B>{esc(cls['name'])}</B>"
    if style["italic"]:
        name_html = f"<I>{name_html}</I>"
    head = name_html if not stereo else f"<I>«{stereo}»</I><BR/>{name_html}"

    rows = [f'<TR><TD {border} BGCOLOR="{style["header"]}"><FONT {name_font} COLOR="{C["text"]}">{head}</FONT></TD></TR>']

    def compartment(items, bg):
        if not items:
            return ""
        lines = "".join(f' {member_line(v, s, t)}<BR ALIGN="LEFT"/>' for v, s, t in items)
        return (f'<TR><TD BGCOLOR="{bg}" ALIGN="LEFT">'
                f'<FONT FACE="DejaVu Sans" POINT-SIZE="11" COLOR="{C["text"]}">{lines}</FONT></TD></TR>')

    attr_items = cls["attrs"]
    if cls["kind"] == "external":
        attr_items = []
    rows.append(compartment(attr_items, C["attr_bg"]))
    rows.append(compartment(cls["methods"], C["method_bg"]))

    ns = f'<FONT POINT-SIZE="9" COLOR="{C["muted"]}">{esc(cls["ns"])}</FONT><BR/>'
    table = (f'<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="5">'
             f'<TR><TD>{ns}</TD></TR>' + "".join(rows) + "</TABLE>")
    extra = ' style="dashed"' if cls["kind"] == "external" else ""
    return f'  "{cls["name"]}" [label=<{table}>, shape=rect{extra}];\n'


def relation_edge(rel, active):
    kind = rel["kind"]
    attrs = [f'COLOR="{C["edge"]}"', 'penwidth="1.4"']
    if kind == "generalization":
        attrs += ['arrowhead="empty"', 'arrowsize="1.1"']
    elif kind == "realization":
        attrs += ['arrowhead="empty"', 'style="dashed"']
    elif kind == "composition":
        # diamond sits at the WHOLE (dst): draw src->dst with dir=back
        attrs += ['dir="back"', 'arrowtail="diamond"']
    elif kind == "association":
        attrs += ['arrowhead="vee"']
        if rel.get("style") == "dashed":
            attrs += ['style="dashed"']
    elif kind == "dependency":
        attrs += ['style="dashed"', 'arrowhead="vee"']
    if rel.get("label"):
        attrs += [f'label=<{esc(rel["label"])}>',
                  f'fontsize="10"',
                  f'fontcolor="{C["muted"]}"']
    if rel.get("srcm"):
        attrs += [f'taillabel=<{esc(rel["srcm"])}>', 'labeldistance="1.6"', 'labelangle="18"']
    if rel.get("dstm"):
        attrs += [f'headlabel=<{esc(rel["dstm"])}>', 'labeldistance="1.6"', 'labelangle="-18"']
    return f'  "{rel["src"]}" -> "{rel["dst"]}" [{", ".join(attrs)}];\n'


def generate(version):
    active = {c["name"]: c for c in CLASSES if c["since"] <= version}
    rels = [r for r in RELATIONS if r["since"] <= version and r["src"] in active and r["dst"] in active]

    namespaces = {}
    for c in active.values():
        if c["kind"] == "external":
            continue
        namespaces.setdefault(c["ns"], []).append(c["name"])

    out = []
    out.append("digraph DoomalayLite {\n")
    out.append('  graph [rankdir="BT", splines="spline", nodesep="0.55", ranksep="1.0", '
               f'fontname="DejaVu Sans", bgcolor="white", compound="true"];\n')
    out.append(f'  node [fontname="DejaVu Sans"];\n')
    out.append(f'  edge [fontname="DejaVu Sans"];\n')

    legend = (
        '  legend [shape=rect, style="rounded,filled", fillcolor="#F8FAFC", color="#94A3B8", '
        'label=< <FONT FACE="DejaVu Sans" POINT-SIZE="10" COLOR="#243447">'
        '<B>Legend</B><BR ALIGN="LEFT"/>'
        '+ public&#160;&#160;- private&#160;&#160;# protected&#160;&#160;underlined = static<BR ALIGN="LEFT"/>'
        '{abstract} {override} {virtual} {readonly}<BR ALIGN="LEFT"/>'
        'hollow triangle = inheritance &#160; dashed = realization / dependency<BR ALIGN="LEFT"/>'
        'filled diamond = composition (at the whole)<BR ALIGN="LEFT"/>'
        '</FONT>>];\n')

    for ns, names in sorted(namespaces.items()):
        out.append(f'  subgraph "cluster_{esc(ns)}" {{\n')
        out.append(f'    label=<<FONT FACE="DejaVu Sans" POINT-SIZE="12" COLOR="{C["muted"]}"><B>{esc(ns)}</B></FONT>>;\n')
        out.append('    style="rounded"; color="#CBD5E1"; margin="14";\n')
        for n in names:
            out.append(class_node(active[n]).replace("\n", "\n    "))
        out.append("  }\n")

    for c in active.values():
        if c["kind"] == "external":
            out.append(class_node(c))

    out.append(legend)
    for rel in rels:
        out.append(relation_edge(rel, active))
    out.append("}\n")
    return "".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--outdir", default=".")
    args = ap.parse_args()

    dot = generate(args.version)
    base = os.path.join(args.outdir, "class_diagram")
    with open(base + ".dot", "w") as f:
        f.write(dot)
    subprocess.run(["dot", "-Tpng", "-Gdpi=130", base + ".dot", "-o", base + ".png"], check=True)
    subprocess.run(["dot", "-Tsvg", base + ".dot", "-o", base + ".svg"], check=True)
    print("rendered", base + ".png/.svg for version", args.version)


if __name__ == "__main__":
    main()
