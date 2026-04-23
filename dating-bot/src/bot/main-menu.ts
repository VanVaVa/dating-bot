import { Keyboard } from "grammy";

export const mainMenuKeyboard = () =>
  new Keyboard()
    .text("Мой профиль")
    .text("Мои лайки")
    .text("Заполнить анкету")
    .row()
    .text("Смотреть анкеты")
    .row()
    .text("Помощь")
    .resized()
    .persistent();

export const HELP_TEXT =
  "Доступные действия:\n" +
  "• /start — регистрация и главное меню\n" +
  "• /profile — просмотр анкеты\n" +
  "• /profile_set — начать пошаговое заполнение анкеты\n" +
  "• /profile_delete — очистить анкету\n" +
  "• /cancel_profile — отменить текущее заполнение анкеты\n" +
  "• /browse — начать просмотр кандидатов с лайк/пропуск\n" +
  "• /likes — посмотреть историю отправленных лайков\n" +
  "• /profile_help — подсказка по заполнению анкеты\n" +
  "• Кнопка «Помощь» — это сообщение\n\n";
