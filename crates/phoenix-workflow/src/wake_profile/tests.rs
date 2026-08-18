use crate::wake_profile::*;
use crate::*;

#[test]
fn registration_plan_declares_reclaimable_observation_effect() {
    let intent = ObserveHandleIntent {
        contract_id: "contract".into(),
        resource: WakeResourceIdentity::Subagent(SubagentResourceIdentity {
            child_conversation_id: "child".into(),
        }),
        expires_at: Timestamp(5),
    };
    let snapshot = WakeRegistrationSnapshot {
        contract_id: "contract".into(),
        resource: intent.resource.clone(),
        registered: false,
        terminal: None,
        runtime_availability: RuntimeAvailability::Idle,
    };
    let plan = registration_plan(
        snapshot.clone(),
        WakeRegistrationEvent::Registered,
        intent.clone(),
    );
    assert_eq!(plan.snapshot, snapshot);
    assert_eq!(plan.effects.len(), 1);
    assert_eq!(
        plan.effects[0].capability,
        ExecutionCapability::ReclaimableObservation
    );
    assert_eq!(plan.effects[0].intent, intent);
}

#[test]
fn cancellation_request_invalidates_registration_effect() {
    let snapshot = WakeRegistrationSnapshot {
        contract_id: "contract".into(),
        resource: WakeResourceIdentity::Subagent(SubagentResourceIdentity {
            child_conversation_id: "child".into(),
        }),
        registered: true,
        terminal: None,
        runtime_availability: RuntimeAvailability::Pending,
    };
    let request = cancellation_request(
        Version(3),
        snapshot.clone(),
        registration_plan(
            snapshot,
            WakeRegistrationEvent::CancelRequested,
            ObserveHandleIntent {
                contract_id: "contract".into(),
                resource: WakeResourceIdentity::Subagent(SubagentResourceIdentity {
                    child_conversation_id: "child".into(),
                }),
                expires_at: Timestamp(12),
            },
        ),
    );
    assert_eq!(request.expected_workflow_version, Version(3));
    assert_eq!(
        request.invalidations,
        vec![EffectInvalidationDecl {
            effect_id: REGISTRATION_EFFECT_ID
        }]
    );
}

#[test]
fn work_scope_identity_decodes_legacy_object_payload() {
    let identity: WorkScopeIdentity =
        serde_json::from_str(r#"{"kind":"Worktree","stable_key":"worktree:/tmp/project"}"#)
            .expect("legacy identity");
    assert_eq!(identity.as_str(), "worktree:/tmp/project");
}

#[test]
fn tmux_identity_without_work_scope_remains_decodable() {
    let identity: TmuxResourceIdentity = serde_json::from_str(
        r#"{"server_token":"server","window_id":"@1","completion_policy":"KeepOpen"}"#,
    )
    .expect("legacy tmux identity");
    assert_eq!(identity.work_scope.as_str(), "legacy-unscoped");
}
