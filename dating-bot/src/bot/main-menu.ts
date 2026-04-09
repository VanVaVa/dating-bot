import { Keyboard } from "grammy";

export const mainMenuKeyboard = () =>
  new Keyboard()
    .text("Мой профиль")
    .row()
    .text("Помощь")
    .resized()
    .persistent();

export const HELP_TEXT =
  "Доступные действия:\n" +
  "• /start — регистрация и главное меню\n" +
  "• Кнопка «Мой профиль» — краткая информация об учётной записи\n" +
  "• Кнопка «Помощь» — это сообщение\n\n" +
  "Дальнейшие функции анкет и знакомств появятся на следующих этапах проекта.";
