'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Header } from '@/components/Header';
import { VideoProctor } from '@/components/VideoProctor';
import { QuestionCard } from '@/components/QuestionCard';
import { QuestionPalette } from '@/components/QuestionPalette';
import { ViolationModal } from '@/components/ViolationModal';
import { SubmitModal } from '@/components/SubmitModal';
import { SubmissionSummary } from '@/components/SubmissionSummary';
import { ExamOnboardingFlow } from '@/components/onboarding/ExamOnboardingFlow';
import {
  mockCandidate,
  mockSections,
  mockQuestions,
} from '@/data/mockExam';
import {
  CandidateInfo,
  ProctorState,
  Question,
  QuestionStatus,
  Section,
  UserAnswer,
} from '@/types/exam';
import { saveViolation } from '@/lib/proctorDB';
import { Shield } from 'lucide-react';

export function ExamPlatform() {
  // Stage flow: 'onboarding' -> 'exam' -> 'submitted'
  const [stage, setStage] = useState<'onboarding' | 'exam' | 'submitted'>('onboarding');

  // Unique session ID for this exam attempt — used to namespace IndexedDB records
  const sessionIdRef = useRef<string>(
    typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `session-${Date.now()}`
  );

  const [candidate] = useState<CandidateInfo>(mockCandidate);
  const [sections] = useState<Section[]>(mockSections);
  const [questions] = useState<Record<string, Question>>(mockQuestions);

  // Active section & question state
  const [activeSectionId, setActiveSectionId] = useState<string>('sec-1');
  const [activeQuestionId, setActiveQuestionId] = useState<string>('q1');

  // Total timer: 90 mins (5400s)
  const [remainingSeconds, setRemainingSeconds] = useState<number>(5400);

  // Modals state
  const [isSubmitModalOpen, setIsSubmitModalOpen] = useState<boolean>(false);

  // Security violation modal
  const [violationState, setViolationState] = useState<{
    isOpen: boolean;
    type: 'tab_switch' | 'fullscreen_exit' | 'multiple_face' | 'face_missing' | 'custom';
    message?: string;
  }>({
    isOpen: false,
    type: 'tab_switch',
  });

  // User answers map
  const [userAnswers, setUserAnswers] = useState<Record<string, UserAnswer>>(() => {
    const initial: Record<string, UserAnswer> = {};
    Object.keys(mockQuestions).forEach((qid) => {
      initial[qid] = {
        questionId: qid,
        selectedOptionIds: [],
        codeAnswer: mockQuestions[qid].codeSnippet || '',
        textAnswer: '',
        status: qid === 'q1' ? 'not_answered' : 'not_visited',
        isBookmarked: false,
        timeSpentSeconds: 0,
        visited: qid === 'q1',
      };
    });
    return initial;
  });

  // AI Proctoring Telemetry State
  const [proctorState, setProctorState] = useState<ProctorState>({
    isCameraActive: true,
    isMicActive: true,
    faceDetected: true,
    faceCount: 1,
    gazeDirection: 'center',
    gazeConfidence: 0.98,
    micVolume: 15,
    ambientNoiseLevel: 'low',
    isSuspicious: false,
    tabSwitchCount: 0,
    fullscreenViolations: 0,
    integrityScore: 98,
    isAiScanning: true,
    // Real detection fields
    motionScore: 0,
    voiceActivityDetected: false,
    speechDetected: false,
    motionViolationCount: 0,
    noiseViolationCount: 0,
    sessionId: sessionIdRef.current,
    logs: [
      {
        id: 'log-init-1',
        timestamp: new Date().toLocaleTimeString(),
        type: 'success',
        message: 'Identity Verified: Photo biometric facial match 99.4%',
        confidence: 0.99,
      },
      {
        id: 'log-init-2',
        timestamp: new Date().toLocaleTimeString(),
        type: 'info',
        message: 'Continuous AI Proctoring session activated. Neural models running.',
        confidence: 0.98,
      },
    ],
  });

  // Countdown timer effect (only runs during 'exam' stage)
  useEffect(() => {
    if (stage !== 'exam') return;
    const timer = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setStage('submitted');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [stage]);

  // Tab switch & focus lost listener (AI Proctoring Security Interceptor)
  useEffect(() => {
    if (stage !== 'exam') return;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        setProctorState((prev) => {
          const newTabCount = prev.tabSwitchCount + 1;
          const newScore = Math.max(50, prev.integrityScore - 5);
          return {
            ...prev,
            tabSwitchCount: newTabCount,
            integrityScore: newScore,
            logs: [
              {
                id: `log-${Date.now()}`,
                timestamp: new Date().toLocaleTimeString(),
                type: 'critical',
                message: `Security Warning: Browser tab focus lost (Incident #${newTabCount})`,
                confidence: 0.99,
              },
              ...prev.logs.slice(0, 15),
            ],
          };
        });

        setViolationState({
          isOpen: true,
          type: 'tab_switch',
          message: 'Browser focus was shifted away from the exam tab. Navigating outside is flagged as potential cheating.',
        });
      } else {
        // Candidate returned to tab - log return
        setProctorState((prev) => ({
          ...prev,
          logs: [
            {
              id: `log-return-${Date.now()}`,
              timestamp: new Date().toLocaleTimeString(),
              type: 'warning',
              message: 'Candidate returned to exam tab — focus loss interval recorded',
              confidence: 0.99,
            },
            ...prev.logs.slice(0, 15),
          ],
        }));
      }
    };

    // Block common tab-switch / navigation keyboard shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey && (
          e.key === 't' || e.key === 'T' ||
          e.key === 'w' || e.key === 'W' ||
          e.key === 'n' || e.key === 'N' ||
          e.key === 'l' || e.key === 'L'
        )) ||
        e.key === 'F5'
      ) {
        e.preventDefault();
        e.stopPropagation();
        setProctorState((prev) => ({
          ...prev,
          isSuspicious: true,
          lastSuspicionReason: `Blocked shortcut: ${e.ctrlKey ? 'Ctrl+' : ''}${e.key}`,
          logs: [
            {
              id: `log-key-${Date.now()}`,
              timestamp: new Date().toLocaleTimeString(),
              type: 'warning',
              message: `Blocked navigation shortcut: ${e.ctrlKey ? 'Ctrl+' : ''}${e.key.toUpperCase()}`,
              confidence: 0.99,
            },
            ...prev.logs.slice(0, 15),
          ],
        }));
      }
    };

    // Warn before page navigation / tab close
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = 'Leaving this page will terminate your exam session and flag a security violation.';
      return e.returnValue;
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [stage]);

  // Fullscreen exit detection listener
  useEffect(() => {
    if (stage !== 'exam') return;

    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        setProctorState((prev) => {
          const newViolations = prev.fullscreenViolations + 1;
          const newScore = Math.max(50, prev.integrityScore - 4);
          return {
            ...prev,
            fullscreenViolations: newViolations,
            integrityScore: newScore,
            logs: [
              {
                id: `log-fs-${Date.now()}`,
                timestamp: new Date().toLocaleTimeString(),
                type: 'critical',
                message: `Security Warning: Fullscreen mode exited (Incident #${newViolations})`,
                confidence: 0.99,
              },
              ...prev.logs.slice(0, 15),
            ],
          };
        });

        setViolationState({
          isOpen: true,
          type: 'fullscreen_exit',
          message: 'Fullscreen mode was exited. Fullscreen assessment mode is strictly mandatory for the entire examination duration.',
        });
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [stage]);

  // Prevent right clicks inside exam
  useEffect(() => {
    if (stage !== 'exam') return;
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    window.addEventListener('contextmenu', handleContextMenu);
    return () => window.removeEventListener('contextmenu', handleContextMenu);
  }, [stage]);

  // Set active question & mark as visited
  const handleSelectQuestion = useCallback((qid: string) => {
    const q = mockQuestions[qid];
    if (!q) return;

    setActiveSectionId(q.sectionId);
    setActiveQuestionId(qid);

    setUserAnswers((prev) => {
      const current = prev[qid];
      if (current && current.status === 'not_visited') {
        return {
          ...prev,
          [qid]: {
            ...current,
            status: 'not_answered',
            visited: true,
          },
        };
      }
      return prev;
    });
  }, []);

  const handleSelectSection = useCallback((secId: string) => {
    setActiveSectionId(secId);
    const sec = mockSections.find((s) => s.id === secId);
    if (sec && sec.questionIds.length > 0) {
      handleSelectQuestion(sec.questionIds[0]);
    }
  }, [handleSelectQuestion]);

  // Current question data
  const currentQuestion = questions[activeQuestionId] || questions['q1'];
  const currentSection = sections.find((s) => s.id === activeSectionId) || sections[0];
  const sectionQuestions = currentSection.questionIds;
  const currentQuestionIndexInSection = sectionQuestions.indexOf(activeQuestionId);
  const isFirst = currentQuestionIndexInSection === 0 && sections[0].id === activeSectionId;
  const isLast =
    currentQuestionIndexInSection === sectionQuestions.length - 1 &&
    sections[sections.length - 1].id === activeSectionId;

  // Question answer actions
  const handleSaveOption = (optionId: string, isMulti: boolean) => {
    setUserAnswers((prev) => {
      const cur = prev[activeQuestionId] || {
        questionId: activeQuestionId,
        selectedOptionIds: [],
        status: 'not_answered',
        isBookmarked: false,
        timeSpentSeconds: 0,
        visited: true,
      };

      let newSelected: string[] = [];
      if (isMulti) {
        const set = new Set<string>(cur.selectedOptionIds || []);
        if (set.has(optionId)) set.delete(optionId);
        else set.add(optionId);
        newSelected = Array.from(set);
      } else {
        newSelected = [optionId];
      }

      const hasAnswer = newSelected.length > 0;
      let newStatus: QuestionStatus = cur.status;
      if (hasAnswer) {
        newStatus = cur.isBookmarked ? 'answered_marked_review' : 'answered';
      } else {
        newStatus = cur.isBookmarked ? 'marked_review' : 'not_answered';
      }

      return {
        ...prev,
        [activeQuestionId]: {
          ...cur,
          selectedOptionIds: newSelected,
          status: newStatus,
        },
      };
    });
  };

  const handleSaveCodeAnswer = (code: string) => {
    setUserAnswers((prev) => {
      const cur = prev[activeQuestionId] || {
        questionId: activeQuestionId,
        selectedOptionIds: [],
        status: 'not_answered',
        isBookmarked: false,
        timeSpentSeconds: 0,
        visited: true,
      };
      const hasAnswer = code.trim().length > 0;
      const newStatus = hasAnswer
        ? cur.isBookmarked
          ? 'answered_marked_review'
          : 'answered'
        : cur.isBookmarked
        ? 'marked_review'
        : 'not_answered';

      return {
        ...prev,
        [activeQuestionId]: {
          ...cur,
          codeAnswer: code,
          status: newStatus,
        },
      };
    });
  };

  const handleSaveTextAnswer = (text: string) => {
    setUserAnswers((prev) => {
      const cur = prev[activeQuestionId] || {
        questionId: activeQuestionId,
        selectedOptionIds: [],
        status: 'not_answered',
        isBookmarked: false,
        timeSpentSeconds: 0,
        visited: true,
      };
      const hasAnswer = text.trim().length > 0;
      const newStatus = hasAnswer
        ? cur.isBookmarked
          ? 'answered_marked_review'
          : 'answered'
        : cur.isBookmarked
        ? 'marked_review'
        : 'not_answered';

      return {
        ...prev,
        [activeQuestionId]: {
          ...cur,
          textAnswer: text,
          status: newStatus,
        },
      };
    });
  };

  const handleClearResponse = () => {
    setUserAnswers((prev) => {
      const cur = prev[activeQuestionId];
      if (!cur) return prev;
      return {
        ...prev,
        [activeQuestionId]: {
          ...cur,
          selectedOptionIds: [],
          textAnswer: '',
          status: cur.isBookmarked ? 'marked_review' : 'not_answered',
        },
      };
    });
  };

  const handleToggleBookmark = () => {
    setUserAnswers((prev) => {
      const cur = prev[activeQuestionId];
      if (!cur) return prev;
      const nextBookmarked = !cur.isBookmarked;
      const hasAnswer =
        (cur.selectedOptionIds && cur.selectedOptionIds.length > 0) ||
        (cur.textAnswer && cur.textAnswer.trim().length > 0);

      let newStatus: QuestionStatus = 'not_answered';
      if (hasAnswer) {
        newStatus = nextBookmarked ? 'answered_marked_review' : 'answered';
      } else {
        newStatus = nextBookmarked ? 'marked_review' : 'not_answered';
      }

      return {
        ...prev,
        [activeQuestionId]: {
          ...cur,
          isBookmarked: nextBookmarked,
          status: newStatus,
        },
      };
    });
  };

  const handleNext = useCallback(() => {
    const nextIdx = currentQuestionIndexInSection + 1;
    if (nextIdx < sectionQuestions.length) {
      handleSelectQuestion(sectionQuestions[nextIdx]);
    } else {
      // Jump to next section if exists
      const nextSecIdx = sections.findIndex((s) => s.id === activeSectionId) + 1;
      if (nextSecIdx < sections.length) {
        handleSelectSection(sections[nextSecIdx].id);
      } else {
        // Last question of test: trigger submit review modal
        setIsSubmitModalOpen(true);
      }
    }
  }, [activeSectionId, currentQuestionIndexInSection, handleSelectQuestion, handleSelectSection, sectionQuestions, sections]);

  const handlePrevious = useCallback(() => {
    const prevIdx = currentQuestionIndexInSection - 1;
    if (prevIdx >= 0) {
      handleSelectQuestion(sectionQuestions[prevIdx]);
    } else {
      // Jump to previous section if exists
      const prevSecIdx = sections.findIndex((s) => s.id === activeSectionId) - 1;
      if (prevSecIdx >= 0) {
        const prevSec = sections[prevSecIdx];
        const lastQ = prevSec.questionIds[prevSec.questionIds.length - 1];
        setActiveSectionId(prevSec.id);
        handleSelectQuestion(lastQ);
      }
    }
  }, [activeSectionId, currentQuestionIndexInSection, handleSelectQuestion, sectionQuestions, sections]);

  const handleMarkForReviewAndNext = useCallback(() => {
    setUserAnswers((prev) => {
      const cur = prev[activeQuestionId];
      if (!cur) return prev;
      const hasAnswer =
        (cur.selectedOptionIds && cur.selectedOptionIds.length > 0) ||
        (cur.textAnswer && cur.textAnswer.trim().length > 0);

      return {
        ...prev,
        [activeQuestionId]: {
          ...cur,
          isBookmarked: true,
          status: hasAnswer ? 'answered_marked_review' : 'marked_review',
        },
      };
    });
    handleNext();
  }, [activeQuestionId, handleNext]);

  const handleRestartExam = () => {
    // Generate fresh session ID for new attempt
    sessionIdRef.current =
      typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `session-${Date.now()}`;
    setStage('onboarding');
    setRemainingSeconds(5400);
    setActiveSectionId('sec-1');
    setActiveQuestionId('q1');
    const initial: Record<string, UserAnswer> = {};
    Object.keys(mockQuestions).forEach((qid) => {
      initial[qid] = {
        questionId: qid,
        selectedOptionIds: [],
        codeAnswer: mockQuestions[qid].codeSnippet || '',
        textAnswer: '',
        status: qid === 'q1' ? 'not_answered' : 'not_visited',
        isBookmarked: false,
        timeSpentSeconds: 0,
        visited: qid === 'q1',
      };
    });
    setUserAnswers(initial);
    setProctorState((prev) => ({
      ...prev,
      tabSwitchCount: 0,
      fullscreenViolations: 0,
      integrityScore: 98,
      isSuspicious: false,
      motionViolationCount: 0,
      noiseViolationCount: 0,
      motionScore: 0,
      voiceActivityDetected: false,
      speechDetected: false,
      sessionId: sessionIdRef.current,
      logs: [
        {
          id: `log-${Date.now()}`,
          timestamp: new Date().toLocaleTimeString(),
          type: 'info',
          message: 'Exam session reset for new onboarding demonstration',
          confidence: 0.99,
        },
      ],
    }));
  };

  // 1. Stage: Onboarding Flow (Permissions -> System Scan -> Calibration -> Instructions + Auto Fullscreen)
  if (stage === 'onboarding') {
    return (
      <ExamOnboardingFlow
        candidate={candidate}
        onStartExam={() => setStage('exam')}
      />
    );
  }

  // 2. Stage: Submitted Summary
  if (stage === 'submitted') {
    return (
      <SubmissionSummary
        candidate={candidate}
        sections={sections}
        questions={questions}
        userAnswers={userAnswers}
        proctorState={proctorState}
        onRestartExam={handleRestartExam}
      />
    );
  }

  // 3. Stage: Live Exam Arena
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans select-none">
      {/* Top Fixed Bar without calculator, whiteboard, shortcuts, instructions, or manual fullscreen */}
      <Header
        candidate={candidate}
        sections={sections}
        activeSectionId={activeSectionId}
        onSelectSection={handleSelectSection}
        remainingSeconds={remainingSeconds}
        totalSeconds={5400}
        onSubmitClick={() => setIsSubmitModalOpen(true)}
        integrityScore={proctorState.integrityScore}
        isAiScanning={proctorState.isAiScanning}
      />

      {/* Main Examination Layout: Dual Column Arena */}
      <main className="flex-1 w-full max-w-7xl mx-auto p-3 sm:p-4 lg:p-6 grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left / Main Column: Question Arena */}
        <div className="lg:col-span-8 flex flex-col gap-5">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeQuestionId}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.2 }}
            >
              <QuestionCard
                question={currentQuestion}
                section={currentSection}
                totalQuestionsInSection={sectionQuestions.length}
                questionIndexInSection={currentQuestionIndexInSection}
                currentAnswer={userAnswers[activeQuestionId]}
                onSaveOption={handleSaveOption}
                onSaveCodeAnswer={handleSaveCodeAnswer}
                onSaveTextAnswer={handleSaveTextAnswer}
                onClearResponse={handleClearResponse}
                onToggleBookmark={handleToggleBookmark}
                onPrevious={handlePrevious}
                onNext={handleNext}
                onMarkForReviewAndNext={handleMarkForReviewAndNext}
                isFirst={isFirst}
                isLast={isLast}
              />
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Right Column: AI Video Proctor + Question Palette Sidebar */}
        <div className="lg:col-span-4 flex flex-col gap-5">
          {/* AI Proctor Video Stream */}
          <VideoProctor
            proctorState={proctorState}
            onUpdateProctorState={setProctorState}
            sessionId={sessionIdRef.current}
            onTriggerViolation={(type, message) => {
              // Persist violation to IndexedDB
              saveViolation({
                id: `viol-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                sessionId: sessionIdRef.current,
                timestamp: new Date().toISOString(),
                type,
                message,
                confidence: 0.92,
                integrityScoreAtEvent: proctorState.integrityScore,
              }).catch(console.warn);

              setViolationState({
                isOpen: true,
                type,
                message,
              });
            }}
          />

          {/* Question Palette & Section Matrix */}
          <QuestionPalette
            candidate={candidate}
            sections={sections}
            activeSectionId={activeSectionId}
            onSelectSection={handleSelectSection}
            questions={questions}
            activeQuestionId={activeQuestionId}
            onSelectQuestion={handleSelectQuestion}
            userAnswers={userAnswers}
            proctorState={proctorState}
            onSubmitClick={() => setIsSubmitModalOpen(true)}
          />
        </div>
      </main>

      {/* Floating System Security Status Footer */}
      <footer className="py-2.5 px-4 bg-white border-t border-slate-200 text-center text-xs text-slate-500 font-mono flex items-center justify-center gap-4">
        <span className="flex items-center gap-1.5 font-medium text-slate-700">
          <Shield className="w-3.5 h-3.5 text-emerald-600" />
          End-to-End Encrypted Assessment Session
        </span>
        <span className="hidden sm:inline text-slate-300">•</span>
        <span className="hidden sm:inline text-slate-500 font-medium">AI Proctoring Engine v4.2 Active</span>
      </footer>

      {/* Modals & Dialogs */}
      <SubmitModal
        isOpen={isSubmitModalOpen}
        sections={sections}
        questions={questions}
        userAnswers={userAnswers}
        onClose={() => setIsSubmitModalOpen(false)}
        onConfirmSubmit={() => {
          setIsSubmitModalOpen(false);
          setStage('submitted');
        }}
      />

      <ViolationModal
        isOpen={violationState.isOpen}
        type={violationState.type}
        message={violationState.message}
        violationCount={
          proctorState.tabSwitchCount +
          proctorState.fullscreenViolations +
          proctorState.motionViolationCount +
          proctorState.noiseViolationCount
        }
        maxViolations={5}
        onAcknowledge={() => {
          setViolationState((p) => ({ ...p, isOpen: false }));
          if (violationState.type === 'fullscreen_exit') {
            document.documentElement.requestFullscreen?.().catch(() => {});
          }
        }}
      />
    </div>
  );
}
