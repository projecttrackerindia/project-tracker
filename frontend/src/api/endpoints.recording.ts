import { get, post, postForm } from './client';

/** "Record this meeting" from the person's own device: sound in short pieces, words out, then minutes and tasks. The sound is never kept. */
export type Recording = { id: string; meetingId: string; title: string; status: string; lines: number; speech: boolean };
export type RecordingLine = { who: string; lang: string | null; text: string; offset: number };
export type RecordingMinutes = {
  sessionId: string; title: string;
  content: { title: string; summary: string; attendees: string[]; discussion: string[]; decisions: string[]; actionItems: { task: string; owner: string | null; due: string | null }[]; risks: string[]; nextMeeting: string | null };
} | null;

export const recordingApi = {
  status: () => get<{ speech: boolean }>('/me/recordings/status'),
  start: (meetingId: string) => post<Recording>('/me/recordings', { meetingId }),
  lines: (id: string) => get<RecordingLine[]>(`/me/recordings/${id}/lines`),
  segment: (id: string, blob: Blob, who: 'me' | 'others', offset: number) => {
    const form = new FormData();
    form.append('file', new File([blob], 'speech.webm', { type: blob.type || 'audio/webm' }));
    form.append('who', who); form.append('offset', String(Math.round(offset)));
    return postForm<RecordingLine | null>(`/me/recordings/${id}/segment`, form);
  },
  finish: (id: string) => post<RecordingMinutes>(`/me/recordings/${id}/finish`, {}),
  tasks: (id: string, items: number[]) => post<{ created: string[] }>(`/me/recordings/${id}/tasks`, { items }),
};
