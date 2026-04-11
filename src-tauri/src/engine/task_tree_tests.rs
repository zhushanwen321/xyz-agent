use super::*;

#[test]
fn test_defaults() {
    let b = TaskBudget::default();
    assert_eq!((b.max_tokens, b.max_turns, b.max_tool_calls), (50_000, 20, 100));
    let u = TaskUsage::default();
    assert_eq!((u.total_tokens, u.tool_uses, u.duration_ms), (0, 0, 0));
}

#[test]
fn test_task_node_serialization_roundtrip() {
    let node = TaskNode {
        task_id: "da_abc12345".to_string(),
        parent_id: None,
        session_id: "sess-1".to_string(),
        description: "test task".to_string(),
        status: TaskStatus::Running,
        mode: AgentMode::Preset,
        subagent_type: Some("code_review".to_string()),
        created_at: "2026-04-10T00:00:00Z".to_string(),
        completed_at: None,
        transcript_path: Some("subagents/da_abc12345.jsonl".to_string()),
        output_file: None,
        budget: TaskBudget::default(),
        usage: TaskUsage::default(),
        children_ids: Vec::new(),
        kill_requested: false,
        pause_requested: false,
        result_summary: None,
        result_injected: false,
    };
    let json = serde_json::to_string(&node).unwrap();
    assert!(json.contains("\"type\":\"task_node\""));
    assert!(json.contains("\"status\":\"running\""));
    let de: TaskNode = serde_json::from_str(&json).unwrap();
    assert_eq!(de.task_id, "da_abc12345");
    assert_eq!(de.status, TaskStatus::Running);
    assert_eq!(de.mode, AgentMode::Preset);
    assert_eq!(de.subagent_type.as_deref(), Some("code_review"));
}

#[test]
fn test_orchestrate_node_serialization_roundtrip() {
    let node = OrchestrateNode {
        node_id: "or_xyz98765".to_string(),
        parent_id: Some("or_parent1".to_string()),
        session_id: "sess-1".to_string(),
        role: NodeRole::Orchestrator,
        depth: 1,
        description: "orchestrator node".to_string(),
        status: OrchestrateStatus::Idle,
        directive: "coordinate tasks".to_string(),
        agent_id: "agent-1".to_string(),
        conversation_path: PathBuf::from("orchestrate/or_xyz98765.jsonl"),
        output_file: None,
        budget: TaskBudget::default(),
        usage: TaskUsage::default(),
        children_ids: vec!["or_child1".to_string()],
        feedback_history: vec![FeedbackMessage {
            timestamp: "2026-04-10T00:00:00Z".to_string(),
            direction: FeedbackDirection::ChildToParent,
            message: "task done".to_string(),
            severity: FeedbackSeverity::Info,
        }],
        reuse_count: 2,
        last_active_at: "2026-04-10T01:00:00Z".to_string(),
        kill_requested: false,
        pause_requested: false,
        result_injected: false,
    };
    let json = serde_json::to_string(&node).unwrap();
    assert!(json.contains("\"type\":\"orchestrate_node\""));
    assert!(json.contains("\"role\":\"orchestrator\""));
    let de: OrchestrateNode = serde_json::from_str(&json).unwrap();
    assert_eq!(de.node_id, "or_xyz98765");
    assert_eq!(de.feedback_history.len(), 1);
    assert_eq!(de.reuse_count, 2);
}

#[test]
fn test_generate_task_id_prefix_and_uniqueness() {
    let da = generate_task_id("dispatch_agent");
    assert!(da.starts_with("da_") && da.len() == 11, "got: {}", da);
    let or = generate_task_id("orchestrate");
    assert!(or.starts_with("or_") && or.len() == 11, "got: {}", or);
    let tk = generate_task_id("unknown");
    assert!(tk.starts_with("tk_") && tk.len() == 11, "got: {}", tk);
    // uniqueness spot check
    assert_ne!(da, generate_task_id("dispatch_agent"));
}

#[test]
fn test_task_tree_crud_and_lifecycle() {
    let mut tree = TaskTree::new();
    // create + get TaskNode
    tree.create_task_node(None, "s1", "do something", AgentMode::Preset, None, None);
    let id = tree.all_task_nodes()[0].task_id.clone();
    assert!(id.starts_with("da_"));
    assert_eq!(tree.get_task_node(&id).unwrap().status, TaskStatus::Pending);

    // status transition with auto completed_at
    tree.update_task_status(&id, TaskStatus::Running);
    assert!(tree.get_task_node(&id).unwrap().completed_at.is_none());
    tree.update_task_status(&id, TaskStatus::Completed);
    assert!(tree.get_task_node(&id).unwrap().completed_at.is_some());

    // create OrchestrateNode — verify parent children_ids auto-maintained
    tree.create_orchestrate_node(
        None, "s1", NodeRole::Orchestrator, 0, "orch", "direct", "a1",
        PathBuf::from("o.jsonl"), None,
    );
    let oid = tree.all_orchestrate_nodes()[0].node_id.clone();
    assert!(oid.starts_with("or_"));
    assert_eq!(tree.get_orchestrate_node(&oid).unwrap().depth, 0);

    // 子节点创建时自动添加到父节点的 children_ids
    tree.create_orchestrate_node(
        Some(oid.clone()), "s1", NodeRole::Executor, 1, "child", "exec", "a2",
        PathBuf::from("c.jsonl"), None,
    );
    assert_eq!(tree.get_orchestrate_node(&oid).unwrap().children_ids.len(), 1);
}

#[test]
fn test_kill_pause_resume() {
    let mut tree = TaskTree::new();
    tree.create_task_node(None, "s1", "t", AgentMode::Preset, None, None);
    let id = tree.all_task_nodes()[0].task_id.clone();

    assert!(!tree.should_kill(&id) && !tree.should_pause(&id));
    tree.request_kill(&id);
    tree.request_pause(&id);
    assert!(tree.should_kill(&id) && tree.should_pause(&id));
    tree.request_resume(&id);
    assert!(tree.should_kill(&id) && !tree.should_pause(&id));
}

#[test]
fn test_request_kill_tree_cascades_to_children() {
    let mut tree = TaskTree::new();
    tree.create_orchestrate_node(
        None, "s1", NodeRole::Orchestrator, 0, "parent", "d", "a1",
        PathBuf::from("p.jsonl"), None,
    );
    let pid = tree.all_orchestrate_nodes()[0].node_id.clone();
    tree.create_orchestrate_node(
        Some(pid.clone()), "s1", NodeRole::Executor, 1, "child", "e", "a2",
        PathBuf::from("c.jsonl"), None,
    );
    // create_orchestrate_node 已自动维护 children_ids
    assert_eq!(tree.get_orchestrate_node(&pid).unwrap().children_ids.len(), 1);
    let cid = tree.all_orchestrate_nodes()[1].node_id.clone();

    tree.request_kill_tree(&pid);
    assert!(tree.get_orchestrate_node(&pid).unwrap().kill_requested);
    assert!(tree.get_orchestrate_node(&cid).unwrap().kill_requested);

    // nonexistent returns false
    assert!(!tree.request_kill_tree("nope"));
}
