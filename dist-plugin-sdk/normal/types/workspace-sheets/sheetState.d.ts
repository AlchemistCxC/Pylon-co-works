import { type SheetId, type SheetInput, type SheetRecord } from './sheetTypes.js';
export interface SheetState {
    sheets: SheetRecord[];
    activeSheetId: SheetId | null;
    recentlyClosed: SheetRecord[];
}
export declare const EMPTY_SHEET_STATE: SheetState;
export type SheetAction = {
    type: 'open';
    sheet: SheetInput;
    now: number;
} | {
    type: 'focus';
    id: SheetId;
    now: number;
} | {
    type: 'togglePin';
    id: SheetId;
    now: number;
} | {
    type: 'close';
    id: SheetId;
    now: number;
} | {
    type: 'closeOthers';
    id: SheetId;
    now: number;
} | {
    type: 'closeRight';
    id: SheetId;
    now: number;
} | {
    type: 'reopen';
    now: number;
};
export declare function createSheetState(sheets?: SheetRecord[], activeSheetId?: SheetId | null, recentlyClosed?: SheetRecord[]): SheetState;
export declare function sheetReducer(state: SheetState, action: SheetAction): SheetState;
