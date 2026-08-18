import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Conversation } from './api';
import { notificationRoute } from './notifications/store';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  closeNotificationsForConversation,
  notifyConversationStateChange,
  registerCoordinatorForNotifications,
  resetNotificationRuntimeForTest,
} from './notifications';

const notifications: MockNotification[] = [];

class MockNotification {
  static permission: NotificationPermission = 'granted';
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closeCalls = 0;

  constructor(public title: string, public options?: NotificationOptions) {
    notifications.push(this);
  }

  close() {
    this.closeCalls++;
    this.onclose?.();
  }
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    slug: 'conv-a',
    model: 'mock',
    cwd: '/tmp/project',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    message_count: 1,
    browser_session_active: false,
    terminal_uses_tmux: false,
    work_scope_key: 'conversation:conv-1',
    state: { type: 'idle' },
    ...overrides,
  };
}

function grantSettings() {
  resetNotificationRuntimeForTest(DEFAULT_NOTIFICATION_SETTINGS);
}

beforeEach(() => {
  notifications.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  resetNotificationRuntimeForTest();
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    writable: true,
    value: MockNotification,
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'hidden',
  });
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Coordinator notification routing', () => {
  it('uses global routes for registered Coordinator ids', () => {
    registerCoordinatorForNotifications('coordinator-id');
    expect(notificationRoute({ id: 'coordinator-id', slug: 'coordinator' }))
      .toBe('/global/coordinator-id');
    expect(notificationRoute({ id: 'ordinary-id', slug: 'ordinary' }))
      .toBe('/c/ordinary');
  });
});

describe('browser desktop notifications', () => {
  it('notification construction failures fail closed', () => {
    grantSettings();
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      writable: true,
      value: class ThrowingNotification {
        static permission: NotificationPermission = 'granted';
        constructor() { throw new Error('blocked'); }
      },
    });

    expect(() => notifyConversationStateChange(
      conversation(),
      { type: 'idle' },
      { type: 'awaiting_user_response', questions: [] },
    )).not.toThrow();
  });

  it('closes delivered notifications when their conversation is acknowledged without clicking', () => {
    grantSettings();

    notifyConversationStateChange(
      conversation(),
      { type: 'idle' },
      { type: 'awaiting_user_response', questions: [] },
    );
    closeNotificationsForConversation('conv-1');

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.closeCalls).toBe(1);
  });

  it('does not close notifications for other conversations when one conversation is acknowledged', () => {
    grantSettings();

    notifyConversationStateChange(
      conversation({ id: 'conv-1', slug: 'conv-a' }),
      { type: 'idle' },
      { type: 'awaiting_user_response', questions: [] },
    );
    notifyConversationStateChange(
      conversation({ id: 'conv-2', slug: 'conv-b' }),
      { type: 'idle' },
      { type: 'awaiting_user_response', questions: [] },
    );
    closeNotificationsForConversation('conv-1');

    expect(notifications).toHaveLength(2);
    expect(notifications[0]?.closeCalls).toBe(1);
    expect(notifications[1]?.closeCalls).toBe(0);
  });

  it('notification clicks acknowledge the triggering conversation through the shared path', () => {
    grantSettings();
    const dispatch = vi.spyOn(window, 'dispatchEvent');

    notifyConversationStateChange(
      conversation(),
      { type: 'idle' },
      { type: 'awaiting_user_response', questions: [] },
    );
    notifications[0]?.onclick?.();
    closeNotificationsForConversation('conv-1');

    expect(notifications[0]?.closeCalls).toBe(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'phoenix:navigate-to-conversation' }));
  });
});
