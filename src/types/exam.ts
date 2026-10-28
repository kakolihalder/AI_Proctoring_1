export type QuestionType = 'single_choice' | 'multiple_choice' | 'coding' | 'text_answer';

export type QuestionStatus = 'not_visited' | 'not_answered' | 'answered' | 'marked_review' | 'answered_marked_review';

export interface QuestionOption {
  id: string;
  label: string;
  text: string;
  codeSnippet?: string;
}

export interface Question {
  id: string;
  number: number;
  sectionId: string;
  type: QuestionType;
  title: string;
  prompt: string;
  codeSnippet?: string;
  codeLanguage?: string;
  imagePlaceholder?: string;
  options?: QuestionOption[];
  correctAnswers?: string[];
  points: number;
  negativePoints?: number;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  topic: string;
  hint?: string;
}

export interface Section {
  id: string;
  name: string;
  description: string;
  questionIds: string[];
  totalTimeMinutes?: number;
}

export interface UserAnswer {
  questionId: string;
  selectedOptionIds?: string[];
  codeAnswer?: string;
  textAnswer?: string;
  status: QuestionStatus;
  isBookmarked: boolean;
  timeSpentSeconds: number;
  visited: boolean;
}

export interface ProctorLogEntry {
  id: string;
  timestamp: string;
  type: 'info' | 'warning' | 'critical' | 'success';
  message: string;
  confidence?: number;
}

export interface ProctorState {
  isCameraActive: boolean;
  isMicActive: boolean;
  faceDetected: boolean;
  faceCount: number;
  gazeDirection: 'center' | 'left' | 'right' | 'up' | 'down' | 'away';
  gazeConfidence: number;
  micVolume: number; // 0-100 (real RMS from Web Audio API)
  ambientNoiseLevel: 'low' | 'moderate' | 'high';
  isSuspicious: boolean;
  lastSuspicionReason?: string;
  tabSwitchCount: number;
  fullscreenViolations: number;
  integrityScore: number; // 0-100
  logs: ProctorLogEntry[];
  isAiScanning: boolean;
  // Real detection fields
  motionScore: number; // 0-100, canvas pixel-diff based
  voiceActivityDetected: boolean; // true when noise exceeds threshold
  speechDetected: boolean; // true when sustained speech detected
  motionViolationCount: number;
  noiseViolationCount: number;
  sessionId: string; // unique per exam session for IndexedDB isolation
}

export interface ViolationRecord {
  id: string;
  sessionId: string;
  timestamp: string;
  type: string;
  message: string;
  confidence: number;
  integrityScoreAtEvent: number;
}

export interface CandidateInfo {
  name: string;
  candidateId: string;
  rollNumber: string;
  email: string;
  avatarUrl: string;
  examName: string;
  examCode: string;
  durationMinutes: number;
}
