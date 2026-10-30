import { set as setApp } from "@/app/store";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { deleteConversation, revertAll } from "./actions";
import { isAgent } from "./models";
import { useChat } from "./store";

export function DeleteChatDialog({ conversationId }: { conversationId: string }) {
  const conv = useChat((s) => s.conversations.find((c) => c.id === conversationId));
  const working = useChat((s) => !!s.requests[conversationId]);
  const close = () => setApp({ dialog: null });
  if (!conv) return null;
  const agent = isAgent(conv.engine);
  return (
    <Dialog
      open
      tone="danger"
      onClose={close}
      eyebrow="▸ DELETE CONVERSATION"
      title={`Delete “${conv.title}”?`}
      description={`${working ? "Its running turn stops. " : ""}The conversation${agent ? ", its activity log and its checkpoints" : " and its messages"} are removed from this device.${agent ? " File changes already on disk are not touched." : ""} This can't be undone.`}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              close();
              void deleteConversation(conversationId);
            }}
          >
            Delete
          </Button>
        </>
      }
    />
  );
}

/** Revert all of a conversation's unreviewed file changes to their checkpoints. */
export function RevertAllDialog({ conversationId, itemIds }: { conversationId: string; itemIds: string[] }) {
  const conv = useChat((s) => s.conversations.find((c) => c.id === conversationId));
  const close = () => setApp({ dialog: null });
  if (!conv) return null;
  const n = itemIds.length;
  return (
    <Dialog
      open
      tone="danger"
      onClose={close}
      eyebrow="▸ REVERT CHANGES"
      title={`Revert ${n} file${n === 1 ? "" : "s"}?`}
      description={`Each file goes back to the checkpoint AgentHub took before the agent changed it; files the agent created move to the Recycle Bin. Edits you made to these files after the agent are lost too. Unsaved editor changes are kept and will show a conflict.`}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void revertAll(itemIds, conv.projectId)}>
            Revert {n} file{n === 1 ? "" : "s"}
          </Button>
        </>
      }
    />
  );
}
