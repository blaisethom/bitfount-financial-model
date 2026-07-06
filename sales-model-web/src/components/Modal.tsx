import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: number | string;
}

export default function Modal({ open, onClose, title, children, maxWidth = 1100 }: Props) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        style={{
          maxWidth,
          maxHeight: '90vh',
          background: 'hsl(var(--background))',
          border: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
        }}
        className="p-0 gap-0 overflow-hidden"
      >
        <DialogHeader className="px-6 py-4 border-b border-border flex-shrink-0">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
