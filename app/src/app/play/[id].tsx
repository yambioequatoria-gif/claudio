import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Card, ErrorNote, Loading, Screen, Txt } from '@/components/ui';
import type { AnswerResult, Category, Game, Question } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { buzz } from '@/lib/haptics';
import { useColors } from '@/lib/theme';

type Phase = 'loading' | 'pick' | 'question' | 'feedback';

export default function PlayScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token, call } = useAuth();
  const c = useColors();
  const [phase, setPhase] = useState<Phase>('loading');
  const [offered, setOffered] = useState<Category[]>([]);
  const [round, setRound] = useState(1);
  const [question, setQuestion] = useState<Question | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [msLeft, setMsLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const deadline = useRef(0);
  const submitting = useRef(false);

  const loadQuestion = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const res = await call<{ question: Question }>(`/games/${id}/question`, { method: 'POST' });
      deadline.current = Date.now() + res.question.msLeft;
      submitting.current = false;
      setMsLeft(res.question.msLeft);
      setQuestion(res.question);
      setPicked(null);
      setResult(null);
      setPhase('question');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [call, id]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const { game } = await call<{ game: Game }>(`/games/${id}`);
      if (game.action === 'pick') {
        setOffered(game.offered);
        setRound(game.round);
        setPhase('pick');
      } else if (game.action === 'answer') {
        await loadQuestion();
      } else {
        router.replace(`/game/${id}`);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [call, id, loadQuestion]);

  useEffect(() => {
    if (token) start();
  }, [token, start]);

  const answer = useCallback(
    async (choice: number | null) => {
      if (submitting.current) return;
      submitting.current = true;
      setPicked(choice);
      try {
        const res = await call<AnswerResult>(`/games/${id}/answer`, { body: { choice } });
        buzz(res.correct ? 'good' : 'bad');
        setResult(res);
        setPhase('feedback');
      } catch (e) {
        setError((e as Error).message);
        setPhase('loading');
      }
    },
    [call, id],
  );

  useEffect(() => {
    if (phase !== 'question') return;
    const timer = setInterval(() => {
      const left = deadline.current - Date.now();
      setMsLeft(Math.max(0, left));
      if (left <= 0) answer(null);
    }, 100);
    return () => clearInterval(timer);
  }, [phase, answer]);

  const choose = async (category: Category) => {
    setPhase('loading');
    try {
      await call(`/games/${id}/category`, { body: { categoryId: category.id } });
      await loadQuestion();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!token) return <Redirect href="/login" />;

  if (phase === 'loading') {
    return (
      <Screen title="Play" back={`/game/${id}`} replaceOnBack>
        {error ? <ErrorNote message={error} onRetry={start} /> : <Loading />}
      </Screen>
    );
  }

  if (phase === 'pick') {
    return (
      <Screen title={`Round ${round}`} back={`/game/${id}`} replaceOnBack>
        <Txt size={22} weight="800">
          Pick a category
        </Txt>
        <Txt muted>You and your opponent both answer the same three questions. The clock starts as soon as you pick.</Txt>
        {offered.map((cat) => (
          <Pressable
            key={cat.id}
            testID={`category-${cat.id}`}
            accessibilityRole="button"
            accessibilityLabel={cat.name}
            onPress={() => {
              buzz('tap');
              choose(cat);
            }}
            style={({ pressed }) => [styles.category, { backgroundColor: cat.color, opacity: pressed ? 0.85 : 1 }]}>
            <Txt size={36}>{cat.emoji}</Txt>
            <Txt size={22} weight="800" color="#FFFFFF">
              {cat.name}
            </Txt>
          </Pressable>
        ))}
      </Screen>
    );
  }

  if (!question) return null;
  const total = question.answerSeconds * 1000;
  const seconds = Math.ceil(msLeft / 1000);
  const urgent = msLeft < 5000;
  const done = phase === 'feedback' && result;

  return (
    <Screen scroll={false}>
      <View style={styles.top}>
        <View style={[styles.badge, { backgroundColor: question.category.color }]}>
          <Txt size={14} weight="700" color="#FFFFFF">
            {question.category.emoji} {question.category.name}
          </Txt>
        </View>
        <Txt weight="700" muted>
          Question {question.position + 1} of {question.total}
        </Txt>
      </View>

      <View
        accessibilityRole="progressbar"
        accessibilityLabel={`${seconds} seconds left`}
        style={[styles.timer, { backgroundColor: c.cardAlt }]}>
        <View style={[styles.timerFill, { width: `${(msLeft / total) * 100}%`, backgroundColor: urgent ? c.bad : c.primary }]} />
      </View>
      <Txt testID="seconds" center weight="800" size={18} color={urgent ? c.bad : c.muted}>
        {done ? (result.timedOut ? "Time's up" : result.correct ? 'Correct!' : 'Wrong') : `${seconds}s`}
      </Txt>

      <Card style={styles.questionCard}>
        <Txt testID="question" size={22} weight="700" center>
          {question.text}
        </Txt>
      </Card>

      <View style={{ gap: 10 }}>
        {question.answers.map((text, i) => {
          let bg = c.card;
          let fg = c.text;
          let border = c.line;
          if (done) {
            if (i === result.correctIndex) [bg, fg, border] = [c.good, '#FFFFFF', c.good];
            else if (i === picked) [bg, fg, border] = [c.bad, '#FFFFFF', c.bad];
          } else if (i === picked) border = c.primary;
          return (
            <Pressable
              key={i}
              testID={`answer-${i}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: picked !== null || !!done, selected: i === picked }}
              disabled={picked !== null || !!done}
              onPress={() => {
                buzz('tap');
                answer(i);
              }}
              style={({ pressed }) => [styles.answer, { backgroundColor: bg, borderColor: border, opacity: pressed ? 0.85 : 1 }]}>
              <Txt size={17} weight="700" center color={fg}>
                {text}
              </Txt>
            </Pressable>
          );
        })}
      </View>

      {error ? <ErrorNote message={error} onRetry={start} /> : null}
      {done ? (
        <View style={{ gap: 10, marginTop: 6 }}>
          {!result.roundComplete ? (
            <Button testID="next" label="Next question" onPress={loadQuestion} />
          ) : result.game.action === 'pick' ? (
            <>
              <Button
                testID="next"
                label={`Pick the category for round ${result.game.round}`}
                onPress={() => {
                  setOffered(result.game.offered);
                  setRound(result.game.round);
                  setPhase('pick');
                }}
              />
              <Button kind="ghost" label="Back to the scoreboard" onPress={() => router.replace(`/game/${id}`)} />
            </>
          ) : (
            <Button
              testID="next"
              label={result.game.action === 'finished' ? 'See the result' : 'Round done · back to the scoreboard'}
              onPress={() => router.replace(`/game/${id}`)}
            />
          )}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  category: { borderRadius: 20, padding: 20, minHeight: 96, flexDirection: 'row', alignItems: 'center', gap: 16 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  badge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  timer: { height: 12, borderRadius: 6, overflow: 'hidden' },
  timerFill: { height: 12, borderRadius: 6 },
  questionCard: { minHeight: 150, justifyContent: 'center' },
  answer: { minHeight: 58, borderRadius: 16, borderWidth: 2, paddingHorizontal: 16, paddingVertical: 12, justifyContent: 'center' },
});
