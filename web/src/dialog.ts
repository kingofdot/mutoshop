import { create } from "zustand";

export interface ConfirmOptions {
  title: string;
  body?: string;
  ok?: string;
  cancel?: string;
  danger?: boolean;
}

interface DialogState {
  current: (ConfirmOptions & { resolve: (v: boolean) => void }) | null;
}

export const useDialog = create<DialogState>(() => ({ current: null }));

/** 확인 대화상자 (Promise 로 결과 반환) */
export function confirmAsk(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useDialog.getState().current?.resolve(false);
    useDialog.setState({
      current: {
        ...o,
        resolve: (v) => {
          useDialog.setState({ current: null });
          resolve(v);
        },
      },
    });
  });
}
