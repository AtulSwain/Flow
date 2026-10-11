/* LangGraph Atlas — content data.
   Diagrams use a 300×180 coordinate space: nodes {id,label,x,y,kind}, edges [from,to,opts]. */
window.ATLAS = (() => {
  const S = (x, y) => ({ id: "start", label: "START", x, y, kind: "terminal" });
  const E = (x, y) => ({ id: "end", label: "END", x, y, kind: "terminal" });

  const concepts = [
    { icon: "▣", name: "State", tag: "schema", text: "The shared memory of a run. A TypedDict, Pydantic model or dataclass (Annotation / Zod in JS). Every node reads it and returns a partial update.",
      code: `class State(TypedDict):
    messages: Annotated[list, add_messages]
    plan: list[str]
    attempts: int` },
    { icon: "⊕", name: "Reducers", tag: "merge rules", text: "Decide how an update combines with the current value. Default is overwrite; add_messages appends and de-duplicates by id; operator.add concatenates.",
      code: `from operator import add

class State(TypedDict):
    results: Annotated[list[str], add]  # append
    status: str                        # overwrite` },
    { icon: "◉", name: "Nodes", tag: "units of work", text: "Plain functions (sync or async) that take state and return an update. They can call LLMs, tools, APIs — or nothing AI at all.",
      code: `def summarize(state: State) -> dict:
    out = llm.invoke(state["messages"])
    return {"messages": [out]}

builder.add_node("summarize", summarize)` },
    { icon: "→", name: "Edges", tag: "control flow", text: "Fixed transitions between nodes. START and END are virtual nodes marking the entry and exit. Multiple outgoing edges run targets in parallel.",
      code: `builder.add_edge(START, "fetch")
builder.add_edge("fetch", "a")   # a and b
builder.add_edge("fetch", "b")   # run in parallel
builder.add_edge(["a", "b"], "merge")` },
    { icon: "⑂", name: "Conditional edges", tag: "routing", text: "A routing function inspects state and returns the next node name(s). Pass a mapping so the graph can be drawn and validated.",
      code: `def route(state) -> str:
    last = state["messages"][-1]
    return "tools" if last.tool_calls else "end"

builder.add_conditional_edges("agent", route,
    {"tools": "tools", "end": END})` },
    { icon: "⇢", name: "Command", tag: "update + goto", text: "Return Command from a node to update state AND choose the next node in one step — ideal for agent handoffs. Can also target a parent graph.",
      code: `def agent(state) -> Command[Literal["review", END]]:
    return Command(
        update={"draft": write(state)},
        goto="review",
    )` },
    { icon: "⇶", name: "Send", tag: "dynamic fan-out", text: "Spawn a variable number of parallel node runs, each with its own private input. The basis of map-reduce and orchestrator-worker patterns.",
      code: `def fan_out(state):
    return [Send("worker", {"item": x})
            for x in state["items"]]

builder.add_conditional_edges("plan", fan_out, ["worker"])` },
    { icon: "⛁", name: "Checkpointer", tag: "short-term memory", text: "Persists a snapshot of state after each super-step, keyed by thread_id. Powers memory, resume-after-failure, HITL and time travel.",
      code: `from langgraph.checkpoint.postgres import PostgresSaver

graph = builder.compile(checkpointer=saver)
graph.invoke(inp, {"configurable": {"thread_id": "u42"}})` },
    { icon: "✋", name: "Interrupts", tag: "human-in-the-loop", text: "interrupt(payload) pauses the graph and returns the payload to the caller. Resume later with Command(resume=value) on the same thread.",
      code: `def approve(state):
    ok = interrupt({"action": state["action"]})
    return {"approved": ok}

graph.invoke(Command(resume=True), config)` },
    { icon: "⌘", name: "Store", tag: "long-term memory", text: "A key-value + vector store shared across threads, namespaced (e.g. per user). Remember preferences and facts between conversations.",
      code: `def node(state, *, store: BaseStore):
    ns = ("memories", user_id)
    store.put(ns, "lang", {"pref": "French"})
    hits = store.search(ns, query="language")` },
    { icon: "⧉", name: "Subgraphs", tag: "composition", text: "A compiled graph can be a node in another graph. Encapsulate teams, reuse components and give each agent private state.",
      code: `research = research_builder.compile()

parent.add_node("research", research)
parent.add_edge(START, "research")` },
    { icon: "≋", name: "Streaming", tag: "real-time UX", text: "stream_mode: values (full state), updates (per-node deltas), messages (LLM tokens), custom (your own events), debug. Combine several at once.",
      code: `for mode, chunk in graph.stream(inp, cfg,
        stream_mode=["updates", "messages"]):
    print(mode, chunk)` },
  ];

  const architectures = [
    {
      id: "react", name: "ReAct tool-calling agent", family: "single", hue: 190,
      tagline: "Reason → act → observe, in a loop.",
      desc: "The canonical agent. The model either answers or emits tool calls; a ToolNode executes them and feeds results back. The loop ends when the model stops calling tools.",
      when: ["Open-ended tasks with a handful of tools", "Chat assistants and copilots", "The default starting point for almost any agent"],
      tradeoffs: "Simple and flexible, but quality depends heavily on the model's tool use; long loops can drift or burn tokens — set a recursion limit.",
      primitives: ["add_messages", "ToolNode", "tools_condition", "cycle"], paper: "ReAct (Yao et al., 2022)",
      diagram: { nodes: [S(30, 90), { id: "a", label: "agent", x: 130, y: 90 }, { id: "t", label: "tools", x: 130, y: 25, kind: "tool" }, E(250, 90)],
        edges: [["start", "a"], ["a", "t", { dashed: true, bend: -30 }], ["t", "a", { bend: -30 }], ["a", "end", { dashed: true }]] },
    },
    {
      id: "router", name: "Router", family: "single", hue: 160,
      tagline: "Classify once, dispatch to a specialist.",
      desc: "An LLM with structured output classifies the input and a conditional edge sends it to exactly one specialised branch. No loop — predictable, cheap and easy to evaluate.",
      when: ["Customer-support triage", "Choosing between retrieval sources", "Sending easy queries to a small model, hard ones to a large one"],
      tradeoffs: "Very controllable, but can't recover if the classification is wrong unless you add a fallback branch.",
      primitives: ["with_structured_output", "conditional edges"], paper: "—",
      diagram: { nodes: [S(25, 90), { id: "r", label: "router", x: 105, y: 90 }, { id: "x", label: "billing", x: 200, y: 30 }, { id: "y", label: "tech", x: 200, y: 90 }, { id: "z", label: "sales", x: 200, y: 150 }, E(280, 90)],
        edges: [["start", "r"], ["r", "x", { dashed: true }], ["r", "y", { dashed: true }], ["r", "z", { dashed: true }], ["x", "end"], ["y", "end"], ["z", "end"]] },
    },
    {
      id: "hitl", name: "Human-in-the-loop agent", family: "single", hue: 40,
      tagline: "Pause for approval before anything irreversible.",
      desc: "Before a sensitive tool runs (send email, pay invoice, write to prod), an interrupt surfaces the proposed action. A person approves, edits or rejects it, and the graph resumes from the checkpoint — minutes or weeks later.",
      when: ["Actions with side effects or cost", "Regulated domains", "Collecting missing information from the user"],
      tradeoffs: "Adds latency and needs a UI for reviewers, but dramatically lowers the blast radius of mistakes.",
      primitives: ["interrupt", "Command(resume)", "checkpointer"], paper: "—",
      diagram: { nodes: [S(25, 90), { id: "a", label: "agent", x: 100, y: 90 }, { id: "h", label: "review ✋", x: 185, y: 40, kind: "human" }, { id: "t", label: "tools", x: 185, y: 140, kind: "tool" }, E(275, 90)],
        edges: [["start", "a"], ["a", "h", { dashed: true }], ["h", "t"], ["h", "a", { dashed: true, bend: 25 }], ["t", "a"], ["a", "end", { dashed: true }]] },
    },
    {
      id: "supervisor", name: "Supervisor (multi-agent)", family: "multi", hue: 265,
      tagline: "One coordinator delegates to specialist agents.",
      desc: "A supervisor LLM decides which worker agent acts next; each worker reports back. Workers can have their own tools, prompts and even models. Available prebuilt as langgraph-supervisor, or hand-built with Command handoffs.",
      when: ["Tasks spanning distinct skills (research, code, writing)", "When one prompt with 30 tools gets confused", "You want a single point of control and logging"],
      tradeoffs: "Clear control, but the supervisor is a bottleneck and adds an LLM call per hop.",
      primitives: ["Command(goto)", "subgraphs", "handoff tools"], paper: "—",
      diagram: { nodes: [S(25, 90), { id: "s", label: "supervisor", x: 115, y: 90, kind: "boss" }, { id: "a", label: "research", x: 225, y: 25 }, { id: "b", label: "coder", x: 245, y: 90 }, { id: "c", label: "writer", x: 225, y: 155 }, E(115, 165)],
        edges: [["start", "s"], ["s", "a", { bend: -12 }], ["a", "s", { bend: -12 }], ["s", "b", { bend: -10 }], ["b", "s", { bend: -10 }], ["s", "c", { bend: -12 }], ["c", "s", { bend: -12 }], ["s", "end", { dashed: true }]] },
    },
    {
      id: "hier", name: "Hierarchical teams", family: "multi", hue: 290,
      tagline: "Supervisors of supervisors.",
      desc: "Each team is a subgraph with its own supervisor and workers; a top-level supervisor routes between teams. Scales the supervisor pattern beyond what one router can handle.",
      when: ["Large organisations of agents", "Teams developed and tested independently", "Different state schemas per team"],
      tradeoffs: "Excellent modularity; more hops means more latency and cost — keep the tree shallow.",
      primitives: ["subgraphs", "Command.PARENT", "private state"], paper: "—",
      diagram: { nodes: [{ id: "top", label: "director", x: 150, y: 22, kind: "boss" }, { id: "ta", label: "research lead", x: 75, y: 85, kind: "boss" }, { id: "tb", label: "writing lead", x: 225, y: 85, kind: "boss" }, { id: "a1", label: "search", x: 35, y: 155 }, { id: "a2", label: "scrape", x: 115, y: 155 }, { id: "b1", label: "draft", x: 185, y: 155 }, { id: "b2", label: "edit", x: 265, y: 155 }],
        edges: [["top", "ta"], ["top", "tb"], ["ta", "a1"], ["ta", "a2"], ["tb", "b1"], ["tb", "b2"]] },
    },
    {
      id: "swarm", name: "Swarm / network", family: "multi", hue: 320,
      tagline: "Peers hand off control directly.",
      desc: "No central boss: any agent can hand off to any other via a handoff tool, and the system remembers which agent was last active so the conversation continues with it. Prebuilt as langgraph-swarm.",
      when: ["Conversational flows that move between specialists", "When the right next agent is obvious to the current one"],
      tradeoffs: "Fewer hops than a supervisor, but harder to reason about globally and easier to ping-pong.",
      primitives: ["Command(goto)", "active_agent state", "handoff tools"], paper: "—",
      diagram: { nodes: [{ id: "a", label: "triage", x: 150, y: 25 }, { id: "b", label: "flights", x: 60, y: 140 }, { id: "c", label: "hotels", x: 240, y: 140 }],
        edges: [["a", "b", { bend: 12 }], ["b", "a", { bend: 12 }], ["a", "c", { bend: 12 }], ["c", "a", { bend: 12 }], ["b", "c", { bend: 12 }], ["c", "b", { bend: 12 }]] },
    },
    {
      id: "mapreduce", name: "Map-reduce / orchestrator-workers", family: "multi", hue: 210,
      tagline: "Fan out N parallel workers, then combine.",
      desc: "An orchestrator decides at runtime how many sub-tasks exist and spawns one worker per task with Send. A reducer on the shared key gathers results safely, then a synthesizer combines them.",
      when: ["Summarising many documents", "Generating report sections in parallel", "Any embarrassingly parallel step"],
      tradeoffs: "Huge latency wins; watch rate limits and total token spend. Use max_concurrency to throttle.",
      primitives: ["Send", "operator.add reducer", "parallel super-step"], paper: "—",
      diagram: { nodes: [S(25, 90), { id: "o", label: "orchestrate", x: 100, y: 90, kind: "boss" }, { id: "w1", label: "worker", x: 185, y: 30 }, { id: "w2", label: "worker", x: 185, y: 90 }, { id: "w3", label: "worker", x: 185, y: 150 }, { id: "r", label: "reduce", x: 265, y: 90 }],
        edges: [["start", "o"], ["o", "w1", { dashed: true }], ["o", "w2", { dashed: true }], ["o", "w3", { dashed: true }], ["w1", "r"], ["w2", "r"], ["w3", "r"]] },
    },
    {
      id: "plan", name: "Plan-and-execute", family: "planning", hue: 140,
      tagline: "Think the whole way first, then do.",
      desc: "A planner produces a multi-step plan; an executor (often a small ReAct agent) completes one step at a time; a re-planner revises the remaining plan after each result or returns the final answer.",
      when: ["Long multi-step tasks", "Saving cost: big model plans, small model executes", "Making progress visible to users"],
      tradeoffs: "More coherent over long horizons; slower than ReAct for simple questions, and plans can go stale.",
      primitives: ["structured output plan", "cycle", "model per node"], paper: "Plan-and-Solve (Wang et al., 2023)",
      diagram: { nodes: [S(25, 90), { id: "p", label: "planner", x: 100, y: 90, kind: "boss" }, { id: "x", label: "executor", x: 195, y: 40 }, { id: "r", label: "replan", x: 195, y: 140 }, E(280, 140)],
        edges: [["start", "p"], ["p", "x"], ["x", "r"], ["r", "x", { dashed: true, bend: 25 }], ["r", "end", { dashed: true }]] },
    },
    {
      id: "reflection", name: "Reflection / Reflexion", family: "planning", hue: 15,
      tagline: "Draft, critique, revise.",
      desc: "A generator produces an answer and a reflector critiques it — optionally grounded by tests, tools or search (Reflexion). The loop continues until the critic is satisfied or an iteration cap is hit.",
      when: ["Code generation with unit tests", "Writing that must meet a rubric", "Any task with a cheap, reliable verifier"],
      tradeoffs: "Measurable quality gains when feedback is grounded; self-critique without external signal can plateau quickly.",
      primitives: ["cycle", "counter in state", "conditional edge"], paper: "Reflexion (Shinn et al., 2023); Self-Refine (Madaan et al., 2023)",
      diagram: { nodes: [S(30, 90), { id: "g", label: "generate", x: 120, y: 90 }, { id: "r", label: "reflect", x: 210, y: 35, kind: "critic" }, E(260, 140)],
        edges: [["start", "g"], ["g", "r", { bend: -20 }], ["r", "g", { bend: -20 }], ["g", "end", { dashed: true }]] },
    },
    {
      id: "rewoo", name: "ReWOO", family: "planning", hue: 100,
      tagline: "Plan with variables, execute without re-asking the LLM.",
      desc: "Reasoning WithOut Observation: the planner writes the full plan with placeholders (#E1, #E2) up front; workers fill them by running tools; a solver writes the answer. Only two LLM calls for reasoning.",
      when: ["Tool-heavy tasks where the steps are predictable", "Reducing tokens versus ReAct"],
      tradeoffs: "Far fewer tokens; cannot adapt the plan if an early tool result is surprising.",
      primitives: ["variable substitution", "cycle over tasks"], paper: "ReWOO (Xu et al., 2023)",
      diagram: { nodes: [S(25, 90), { id: "p", label: "planner", x: 100, y: 90, kind: "boss" }, { id: "w", label: "worker", x: 185, y: 90, kind: "tool" }, { id: "s", label: "solver", x: 265, y: 90 }],
        edges: [["start", "p"], ["p", "w"], ["w", "w", { loop: true }], ["w", "s"]] },
    },
    {
      id: "llmcompiler", name: "LLMCompiler", family: "planning", hue: 230,
      tagline: "A DAG of tool calls, executed in parallel.",
      desc: "The planner streams a dependency graph of tasks; a task-fetching unit schedules each as soon as its inputs are ready, in parallel; a joiner decides to answer or replan.",
      when: ["Many independent tool calls", "Latency-critical agents"],
      tradeoffs: "Fastest of the planning family; the most complex to implement and debug.",
      primitives: ["streaming planner", "parallel tasks", "replan cycle"], paper: "LLMCompiler (Kim et al., 2023)",
      diagram: { nodes: [S(25, 90), { id: "p", label: "planner", x: 95, y: 90, kind: "boss" }, { id: "t1", label: "task", x: 170, y: 35, kind: "tool" }, { id: "t2", label: "task", x: 170, y: 90, kind: "tool" }, { id: "t3", label: "task", x: 170, y: 145, kind: "tool" }, { id: "j", label: "joiner", x: 255, y: 90 }],
        edges: [["start", "p"], ["p", "t1"], ["p", "t2"], ["t2", "t3"], ["t1", "j"], ["t3", "j"], ["j", "p", { dashed: true, bend: 55 }]] },
    },
    {
      id: "lats", name: "Language Agent Tree Search", family: "planning", hue: 345,
      tagline: "Monte-Carlo tree search over agent trajectories.",
      desc: "Combines reflection, evaluation and MCTS: expand several candidate actions, score them with a value function, back-propagate rewards and keep exploring the most promising branch.",
      when: ["Hard reasoning or coding problems", "When accuracy matters more than cost"],
      tradeoffs: "State-of-the-art results on some benchmarks; expensive — many LLM calls per answer.",
      primitives: ["tree in state", "cycle", "Send for expansion"], paper: "LATS (Zhou et al., 2023); Tree of Thoughts (Yao et al., 2023)",
      diagram: { nodes: [S(25, 90), { id: "s", label: "select", x: 100, y: 90 }, { id: "x", label: "expand", x: 180, y: 30 }, { id: "v", label: "evaluate", x: 255, y: 90, kind: "critic" }, { id: "b", label: "backprop", x: 180, y: 150 }],
        edges: [["start", "s"], ["s", "x"], ["x", "v"], ["v", "b"], ["b", "s"]] },
    },
    {
      id: "crag", name: "Corrective / Self-RAG", family: "rag", hue: 175,
      tagline: "Retrieve, grade, and fix bad retrieval.",
      desc: "Documents are graded for relevance; if they're weak the query is rewritten or a web search is triggered. After generation, the answer is checked for hallucination and for actually answering the question.",
      when: ["Knowledge bases with uneven coverage", "When plain RAG returns confident nonsense"],
      tradeoffs: "Much more reliable answers; 2–4× the LLM calls of naive RAG — use a small grader model.",
      primitives: ["structured-output graders", "conditional edges", "cycle"], paper: "CRAG (Yan et al., 2024); Self-RAG (Asai et al., 2023)",
      diagram: { nodes: [S(20, 90), { id: "r", label: "retrieve", x: 85, y: 90, kind: "tool" }, { id: "g", label: "grade", x: 160, y: 90, kind: "critic" }, { id: "w", label: "rewrite", x: 160, y: 25 }, { id: "a", label: "generate", x: 240, y: 90 }, E(240, 160)],
        edges: [["start", "r"], ["r", "g"], ["g", "w", { dashed: true }], ["w", "r", { bend: 20 }], ["g", "a", { dashed: true }], ["a", "end", { dashed: true }]] },
    },
    {
      id: "adaptive", name: "Adaptive / agentic RAG", family: "rag", hue: 55,
      tagline: "Let the agent decide whether and where to retrieve.",
      desc: "A router picks the retrieval strategy per question — none, a vector store, or web search — and retrieval itself is exposed as a tool the agent can call repeatedly.",
      when: ["Mixed traffic: chit-chat, internal docs and current events", "Multiple heterogeneous knowledge sources"],
      tradeoffs: "Saves cost on easy questions; routing errors are silent unless you evaluate them.",
      primitives: ["router", "retriever tool", "ToolNode"], paper: "Adaptive-RAG (Jeong et al., 2024)",
      diagram: { nodes: [S(20, 90), { id: "q", label: "route", x: 90, y: 90 }, { id: "v", label: "vector db", x: 175, y: 35, kind: "tool" }, { id: "w", label: "web", x: 175, y: 145, kind: "tool" }, { id: "g", label: "answer", x: 260, y: 90 }],
        edges: [["start", "q"], ["q", "v", { dashed: true }], ["q", "w", { dashed: true }], ["q", "g", { dashed: true }], ["v", "g"], ["w", "g"]] },
    },
  ];

  const patterns = [
    { name: "Prompt chaining", kind: "workflow", primitive: "add_edge sequence",
      desc: "Split a task into fixed steps where each LLM call processes the previous output. Add programmatic gates between steps to check progress.",
      when: "The task decomposes cleanly into fixed sub-tasks; trade latency for accuracy.",
      diagram: { nodes: [S(20, 90), { id: "a", label: "outline", x: 95, y: 90 }, { id: "g", label: "gate", x: 165, y: 90, kind: "critic" }, { id: "b", label: "write", x: 235, y: 90 }, E(290, 90)],
        edges: [["start", "a"], ["a", "g"], ["g", "b", { dashed: true }], ["b", "end"]] },
      code: `builder.add_edge(START, "outline")
builder.add_conditional_edges("outline", passes_gate,
    {True: "write", False: END})
builder.add_edge("write", END)` },
    { name: "Routing", kind: "workflow", primitive: "conditional edges",
      desc: "Classify the input and direct it to a specialised follow-up. Separation of concerns lets each branch have its own prompt and model.",
      when: "Distinct categories that are better handled separately, and classification is reliable.",
      diagram: { nodes: [S(20, 90), { id: "r", label: "classify", x: 100, y: 90 }, { id: "a", label: "refund", x: 200, y: 35 }, { id: "b", label: "question", x: 200, y: 145 }, E(280, 90)],
        edges: [["start", "r"], ["r", "a", { dashed: true }], ["r", "b", { dashed: true }], ["a", "end"], ["b", "end"]] },
      code: `class Route(BaseModel):
    step: Literal["refund", "question"]

router = llm.with_structured_output(Route)
builder.add_conditional_edges("classify",
    lambda s: router.invoke(s["input"]).step)` },
    { name: "Parallelization", kind: "workflow", primitive: "fan-out edges + reducer",
      desc: "Run independent LLM calls simultaneously — sectioning (different sub-tasks) or voting (same task several times) — and aggregate.",
      when: "Sub-tasks are independent, or you want multiple perspectives / higher confidence.",
      diagram: { nodes: [S(20, 90), { id: "a", label: "security", x: 135, y: 30 }, { id: "b", label: "style", x: 135, y: 90 }, { id: "c", label: "perf", x: 135, y: 150 }, { id: "m", label: "aggregate", x: 255, y: 90 }],
        edges: [["start", "a"], ["start", "b"], ["start", "c"], ["a", "m"], ["b", "m"], ["c", "m"]] },
      code: `for n in ["security", "style", "perf"]:
    builder.add_edge(START, n)
builder.add_edge(["security", "style", "perf"],
                 "aggregate")` },
    { name: "Orchestrator-workers", kind: "workflow", primitive: "Send",
      desc: "A central LLM breaks the task down dynamically, delegates to workers, and synthesises their results. Unlike parallelization, the sub-tasks aren't known in advance.",
      when: "Complex tasks where you can't predict the sub-tasks — e.g. which files a code change touches.",
      diagram: { nodes: [S(20, 90), { id: "o", label: "orchestrator", x: 100, y: 90, kind: "boss" }, { id: "w1", label: "worker", x: 190, y: 35 }, { id: "w2", label: "worker", x: 190, y: 90 }, { id: "w3", label: "worker", x: 190, y: 145 }, { id: "s", label: "synth", x: 270, y: 90 }],
        edges: [["start", "o"], ["o", "w1", { dashed: true }], ["o", "w2", { dashed: true }], ["o", "w3", { dashed: true }], ["w1", "s"], ["w2", "s"], ["w3", "s"]] },
      code: `def assign(state):
    return [Send("worker", {"section": s})
            for s in state["sections"]]

builder.add_conditional_edges("orchestrator", assign, ["worker"])` },
    { name: "Evaluator-optimizer", kind: "workflow", primitive: "cycle",
      desc: "One LLM generates, another evaluates and gives feedback, in a loop until the output is accepted.",
      when: "Clear evaluation criteria exist and iterative refinement measurably helps.",
      diagram: { nodes: [S(20, 90), { id: "g", label: "generate", x: 110, y: 90 }, { id: "e", label: "evaluate", x: 210, y: 90, kind: "critic" }, E(280, 160)],
        edges: [["start", "g"], ["g", "e", { bend: -25 }], ["e", "g", { dashed: true, bend: -25 }], ["e", "end", { dashed: true }]] },
      code: `builder.add_edge("generate", "evaluate")
builder.add_conditional_edges("evaluate",
    lambda s: END if s["grade"] == "pass" else "generate")` },
    { name: "Autonomous agent", kind: "agent", primitive: "tool loop",
      desc: "The LLM plans and acts with tools in a loop, using environment feedback, until it decides the task is done. Maximum flexibility, minimum predictability.",
      when: "Open-ended problems where the number of steps can't be predicted; you trust the model and have guardrails.",
      diagram: { nodes: [S(25, 90), { id: "a", label: "LLM", x: 130, y: 90 }, { id: "t", label: "environment", x: 130, y: 25, kind: "tool" }, E(250, 90)],
        edges: [["start", "a"], ["a", "t", { bend: -30 }], ["t", "a", { bend: -30 }], ["a", "end", { dashed: true }]] },
      code: `agent = create_agent(model, tools=tools,
                     system_prompt="You are a careful SRE.")
agent.invoke({"messages": [("user", task)]},
             {"recursion_limit": 40})` },
  ];

  const models = [
    { name: "Anthropic", pkg: "langchain-anthropic", prefix: "anthropic:claude-sonnet-5-5", hue: 22, note: "Claude family (Opus, Sonnet, Haiku). Strong tool use and long context; supports prompt caching and extended thinking." },
    { name: "OpenAI", pkg: "langchain-openai", prefix: "openai:<model>", hue: 160, note: "GPT and reasoning models; native structured outputs and parallel tool calls. Responses API supported." },
    { name: "Google", pkg: "langchain-google-genai", prefix: "google_genai:<model>", hue: 215, note: "Gemini models via the Gemini API; Vertex AI through langchain-google-vertexai. Very long context, multimodal." },
    { name: "AWS Bedrock", pkg: "langchain-aws", prefix: "bedrock_converse:<model-id>", hue: 35, note: "One API for many vendors' models inside your AWS account — Claude, Llama, Mistral, Nova and more." },
    { name: "Azure OpenAI", pkg: "langchain-openai", prefix: "azure_openai:<deployment>", hue: 200, note: "OpenAI models deployed in your Azure tenant, with enterprise networking and compliance." },
    { name: "Mistral", pkg: "langchain-mistralai", prefix: "mistralai:<model>", hue: 28, note: "European provider with open-weight and commercial models; function calling supported." },
    { name: "Groq", pkg: "langchain-groq", prefix: "groq:<model>", hue: 0, note: "Very low-latency inference for open-weight models — good for routers and graders." },
    { name: "Ollama", pkg: "langchain-ollama", prefix: "ollama:llama3.1", hue: 0, gray: true, note: "Run open-weight models (Llama, Qwen, Mistral, DeepSeek…) locally. Check that the model supports tool calling." },
    { name: "Fireworks / Together", pkg: "langchain-fireworks · langchain-together", prefix: "fireworks:<model>", hue: 275, note: "Hosted open-weight models with OpenAI-compatible APIs and fine-tuning." },
    { name: "Hugging Face", pkg: "langchain-huggingface", prefix: "huggingface:<repo-id>", hue: 48, note: "Inference endpoints or local transformers pipelines for the long tail of models." },
  ];

  const capabilities = [
    { name: "Tool / function calling", level: 5, text: "Every agent loop, handoff and ToolNode depends on it. Test with your real tool schemas." },
    { name: "Structured output", level: 5, text: "Routers, graders and planners return typed objects. Reliability here = reliable control flow." },
    { name: "Streaming", level: 4, text: "Token streaming makes multi-step agents feel responsive (stream_mode=\"messages\")." },
    { name: "Long context", level: 3, text: "Message histories grow every loop. Trim or summarize — or pick a model that tolerates it." },
    { name: "Parallel tool calls", level: 3, text: "One turn, many calls: fewer loop iterations and lower latency." },
    { name: "Multimodal input", level: 2, text: "Screenshots, PDFs and charts as state — useful for computer-use and document agents." },
  ];

  const timeline = [
    { when: "2010", title: "Pregel paper", text: "Google describes Pregel, a vertex-centric, super-step model for large-scale graph processing — the execution model LangGraph's runtime borrows." },
    { when: "Oct 2022", title: "ReAct & LangChain", text: "ReAct shows LLMs interleaving reasoning and tool use; LangChain launches as an open-source toolkit for LLM apps." },
    { when: "Jan 2024", title: "LangGraph launches", text: "Released for Python and JS to model cyclic, stateful agent workflows that LangChain's chains couldn't express." },
    { when: "Mid 2024", title: "Cloud & Studio", text: "LangGraph Cloud (later LangGraph Platform) for deploying graphs, and LangGraph Studio, a visual agent IDE." },
    { when: "Early 2025", title: "Functional API & multi-agent libs", text: "@entrypoint / @task bring LangGraph features to ordinary code; langgraph-supervisor and langgraph-swarm package common multi-agent designs." },
    { when: "Oct 2025", title: "LangGraph 1.0", text: "First stable major release with a commitment to API stability; LangChain 1.0's create_agent is built on it, and the deployment platform moves under LangSmith." },
  ];

  const papers = [
    { title: "Pregel: A System for Large-Scale Graph Processing", who: "Malewicz et al.", year: 2010, link: "https://dl.acm.org/doi/10.1145/1807167.1807184", arch: "Runtime", idea: "Computation in synchronized super-steps where vertices exchange messages." },
    { title: "ReAct: Synergizing Reasoning and Acting in Language Models", who: "Yao et al.", year: 2022, link: "https://arxiv.org/abs/2210.03629", arch: "ReAct agent", idea: "Interleave thoughts with tool actions and observations." },
    { title: "Reflexion: Language Agents with Verbal Reinforcement Learning", who: "Shinn et al.", year: 2023, link: "https://arxiv.org/abs/2303.11366", arch: "Reflection", idea: "Agents store self-reflections from failures to improve next attempts." },
    { title: "Self-Refine: Iterative Refinement with Self-Feedback", who: "Madaan et al.", year: 2023, link: "https://arxiv.org/abs/2303.17651", arch: "Evaluator-optimizer", idea: "The same model generates, critiques and refines its output." },
    { title: "Plan-and-Solve Prompting", who: "Wang et al.", year: 2023, link: "https://arxiv.org/abs/2305.04091", arch: "Plan-and-execute", idea: "Devise a plan first, then carry out sub-tasks." },
    { title: "ReWOO: Decoupling Reasoning from Observations", who: "Xu et al.", year: 2023, link: "https://arxiv.org/abs/2305.18323", arch: "ReWOO", idea: "Plan with variable placeholders to avoid redundant LLM calls." },
    { title: "An LLM Compiler for Parallel Function Calling", who: "Kim et al.", year: 2023, link: "https://arxiv.org/abs/2312.04511", arch: "LLMCompiler", idea: "Plan a DAG of function calls and execute them in parallel." },
    { title: "Tree of Thoughts: Deliberate Problem Solving with LLMs", who: "Yao et al.", year: 2023, link: "https://arxiv.org/abs/2305.10601", arch: "LATS", idea: "Search over a tree of intermediate thoughts with evaluation and backtracking." },
    { title: "Language Agent Tree Search", who: "Zhou et al.", year: 2023, link: "https://arxiv.org/abs/2310.04406", arch: "LATS", idea: "Unify reasoning, acting and planning with Monte-Carlo tree search." },
    { title: "Self-RAG: Learning to Retrieve, Generate, and Critique", who: "Asai et al.", year: 2023, link: "https://arxiv.org/abs/2310.11511", arch: "Self-RAG", idea: "Decide when to retrieve and critique generations with reflection tokens." },
    { title: "Corrective Retrieval Augmented Generation", who: "Yan et al.", year: 2024, link: "https://arxiv.org/abs/2401.15884", arch: "CRAG", idea: "Grade retrieved docs; fall back to web search when they're poor." },
    { title: "Adaptive-RAG: Adapting Retrieval by Question Complexity", who: "Jeong et al.", year: 2024, link: "https://arxiv.org/abs/2403.14403", arch: "Adaptive RAG", idea: "Route each query to no-, single- or multi-step retrieval." },
    { title: "STORM: Writing Wikipedia-like Articles from Scratch", who: "Shao et al.", year: 2024, link: "https://arxiv.org/abs/2402.14207", arch: "Multi-agent research", idea: "Simulated multi-perspective interviews drive outline-then-write generation." },
    { title: "Generative Agents: Interactive Simulacra of Human Behavior", who: "Park et al.", year: 2023, link: "https://arxiv.org/abs/2304.03442", arch: "Long-term memory", idea: "Memory streams, reflection and retrieval give agents persistent identity." },
  ];

  const checklist = [
    ["Use a durable checkpointer", "PostgresSaver (or another DB-backed saver) instead of in-memory, so runs survive restarts and scale across workers."],
    ["Cap every loop", "Set recursion_limit and keep iteration counters in state for reflection or retry cycles."],
    ["Add retry policies & timeouts", "RetryPolicy on nodes that call flaky APIs; time-box tools so one hung call doesn't stall a thread."],
    ["Return tool errors to the model", "Let ToolNode turn exceptions into ToolMessages so the agent can correct itself instead of crashing."],
    ["Validate structured outputs", "Pydantic/Zod schemas for routers and planners; route invalid outputs to a fallback branch."],
    ["Bound the context window", "Trim or summarize message history; move durable facts into the Store."],
    ["Gate side effects with interrupts", "Require approval before payments, emails, deletes or production writes."],
    ["Make side effects idempotent", "Resumes replay the interrupted node from the start — wrap non-idempotent work in tasks or separate nodes."],
    ["Trace everything", "Turn on LangSmith (or OpenTelemetry) tracing to see every node, prompt, tool call, token and latency."],
    ["Build an eval set", "Regression-test trajectories and final answers on real examples before each prompt or model change."],
    ["Stream progress to users", "Stream updates and tokens so long runs feel alive; show which node is working."],
    ["Least-privilege tools", "Scope credentials per tool, sanitize inputs, and treat retrieved content as untrusted (prompt injection)."],
  ];

  const faq = [
    ["Do I need LangChain to use LangGraph?", "No. Nodes are plain functions — call the Anthropic, OpenAI or any other SDK directly. LangChain integrations are convenient (uniform messages, tool binding, init_chat_model) but optional."],
    ["What's the difference between LangGraph and create_agent / create_react_agent?", "create_agent (LangChain 1.0, successor to langgraph.prebuilt.create_react_agent) is a prebuilt ReAct-style agent compiled to a LangGraph graph. Use it for standard agents; drop down to StateGraph when you need custom control flow."],
    ["Graph API or Functional API?", "The Graph API (StateGraph) makes control flow explicit and visual — great for complex branching and multi-agent systems. The Functional API (@entrypoint, @task) adds persistence, interrupts and streaming to ordinary Python/JS control flow with minimal restructuring. They share the same runtime and can be mixed."],
    ["How is short-term memory different from long-term memory?", "Short-term memory is the thread's state, saved by the checkpointer and scoped to one conversation. Long-term memory lives in a Store, namespaced (e.g. by user) and shared across threads."],
    ["What happens to code before interrupt() when I resume?", "The node containing the interrupt re-runs from its beginning on resume, so code before interrupt() executes again. Keep side effects after the interrupt or in a separate node."],
    ["Why did I get GraphRecursionError?", "The run exceeded recursion_limit super-steps — usually an agent loop that never reaches END. Fix the stop condition, or raise the limit in the config for genuinely long tasks."],
    ["Can parallel nodes write to the same key?", "Only if that key has a reducer (e.g. operator.add or add_messages). Without one, concurrent writes in the same super-step raise an InvalidUpdateError."],
    ["Do I need LangSmith to deploy?", "No. A compiled graph is just a Python/JS object — serve it from FastAPI, Express, a queue worker or a notebook. LangSmith Deployment adds managed persistence, task queues, cron, double-texting handling and Studio."],
  ];

  const code = {
    py: `# pip install -U langgraph "langchain[anthropic]"
from typing import Annotated
from typing_extensions import TypedDict

from langchain.chat_models import init_chat_model
from langchain_core.tools import tool
from langgraph.graph import StateGraph, START
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition
from langgraph.checkpoint.memory import InMemorySaver


@tool
def get_weather(city: str) -> str:
    """Return the current weather for a city."""
    return f"It's always sunny in {city}!"


tools = [get_weather]
llm = init_chat_model("anthropic:claude-sonnet-5-5").bind_tools(tools)


class State(TypedDict):
    messages: Annotated[list, add_messages]   # reducer: append


def agent(state: State):
    return {"messages": [llm.invoke(state["messages"])]}


builder = StateGraph(State)
builder.add_node("agent", agent)
builder.add_node("tools", ToolNode(tools))
builder.add_edge(START, "agent")
builder.add_conditional_edges("agent", tools_condition)  # -> "tools" | END
builder.add_edge("tools", "agent")                       # the loop

graph = builder.compile(checkpointer=InMemorySaver())

config = {"configurable": {"thread_id": "demo-1"}}
for update in graph.stream(
    {"messages": [("user", "What's the weather in Paris?")]},
    config,
    stream_mode="updates",
):
    print(update)

# Same thread_id => the agent remembers the conversation
graph.invoke({"messages": [("user", "And what city did I ask about?")]}, config)`,

    js: `// npm i @langchain/langgraph @langchain/anthropic @langchain/core zod
import { StateGraph, MessagesAnnotation, START, MemorySaver } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const getWeather = tool(async ({ city }) => \`It's always sunny in \${city}!\`, {
  name: "get_weather",
  description: "Return the current weather for a city.",
  schema: z.object({ city: z.string() }),
});

const tools = [getWeather];
const llm = new ChatAnthropic({ model: "claude-sonnet-5-5" }).bindTools(tools);

const agent = async (state: typeof MessagesAnnotation.State) => ({
  messages: [await llm.invoke(state.messages)],
});

const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", agent)
  .addNode("tools", new ToolNode(tools))
  .addEdge(START, "agent")
  .addConditionalEdges("agent", toolsCondition)
  .addEdge("tools", "agent")
  .compile({ checkpointer: new MemorySaver() });

const config = { configurable: { thread_id: "demo-1" } };
const stream = await graph.stream(
  { messages: [{ role: "user", content: "What's the weather in Paris?" }] },
  { ...config, streamMode: "updates" },
);
for await (const update of stream) console.log(update);`,

    hitl: `from langgraph.types import interrupt, Command
from langgraph.checkpoint.memory import InMemorySaver  # PostgresSaver in prod


def send_email(state: State):
    # Pauses here. The payload is returned to whoever invoked the graph.
    decision = interrupt({
        "question": "Send this email?",
        "draft": state["draft"],
    })
    # NOTE: on resume this node restarts from the top,
    # so keep side effects *after* the interrupt.
    if decision["approve"]:
        mailer.send(decision.get("edited", state["draft"]))
        return {"status": "sent"}
    return {"status": "rejected", "feedback": decision.get("feedback")}


graph = builder.compile(checkpointer=InMemorySaver())
config = {"configurable": {"thread_id": "email-42"}}

result = graph.invoke({"draft": draft}, config)
print(result["__interrupt__"])          # paused — show this to a reviewer

# ...minutes or days later, from any process sharing the checkpointer:
graph.invoke(Command(resume={"approve": True}), config)`,

    send: `import operator
from typing import Annotated
from typing_extensions import TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.types import Send


class State(TypedDict):
    docs: list[str]
    summaries: Annotated[list[str], operator.add]  # merges parallel writes
    final: str


def fan_out(state: State):
    # One parallel "summarize" run per document, each with private input
    return [Send("summarize", {"doc": d}) for d in state["docs"]]


def summarize(payload: dict):
    text = llm.invoke(f"Summarize in 2 sentences:\\n{payload['doc']}").content
    return {"summaries": [text]}


def reduce(state: State):
    joined = "\\n".join(state["summaries"])
    return {"final": llm.invoke(f"Combine into one brief:\\n{joined}").content}


builder = StateGraph(State)
builder.add_node("summarize", summarize)
builder.add_node("reduce", reduce)
builder.add_conditional_edges(START, fan_out, ["summarize"])
builder.add_edge("summarize", "reduce")
builder.add_edge("reduce", END)

graph = builder.compile()
graph.invoke({"docs": docs}, {"max_concurrency": 8})`,

    cmd: `from typing import Literal
from pydantic import BaseModel
from langgraph.graph import MessagesState, StateGraph, START, END
from langgraph.types import Command


class Route(BaseModel):
    next: Literal["billing", "tech", "done"]


router = init_chat_model("anthropic:claude-haiku-5-5").with_structured_output(Route)


def triage(state: MessagesState) -> Command[Literal["billing", "tech", "__end__"]]:
    choice = router.invoke(state["messages"]).next
    if choice == "done":
        return Command(goto=END)
    # Update state AND hand off control in a single step
    return Command(goto=choice,
                   update={"messages": [("ai", f"Transferring you to {choice}.")]})


def billing(state: MessagesState) -> Command[Literal["triage"]]:
    reply = billing_agent.invoke(state)
    return Command(goto="triage", update={"messages": reply["messages"]})


def tech(state: MessagesState) -> Command[Literal["triage"]]:
    reply = tech_agent.invoke(state)
    return Command(goto="triage", update={"messages": reply["messages"]})


builder = StateGraph(MessagesState)
builder.add_node(triage)
builder.add_node(billing)
builder.add_node(tech)
builder.add_edge(START, "triage")       # no other edges needed
graph = builder.compile()`,

    func: `from langgraph.func import entrypoint, task
from langgraph.types import interrupt, Command
from langgraph.checkpoint.memory import InMemorySaver


@task
def research(topic: str) -> str:
    return llm.invoke(f"Collect key facts about {topic}").content


@task
def write(topic: str, facts: str) -> str:
    return llm.invoke(f"Write an essay on {topic} using:\\n{facts}").content


@entrypoint(checkpointer=InMemorySaver())
def essay_workflow(topic: str) -> dict:
    facts = research(topic).result()        # task results are checkpointed
    essay = write(topic, facts).result()     # and not re-run on resume
    verdict = interrupt({"essay": essay, "action": "approve?"})
    return {"essay": essay, "approved": verdict}


config = {"configurable": {"thread_id": "essay-7"}}
essay_workflow.invoke("graph neural networks", config)
essay_workflow.invoke(Command(resume=True), config)`,
  };

  return { concepts, architectures, patterns, models, capabilities, timeline, papers, checklist, faq, code };
})();
