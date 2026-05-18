import { Keyboard } from "grammy";

export const mainMenuKeyboard = () =>
  new Keyboard()
    .text("Мой профиль")
    .text("Мои лайки")
    .text("Мэтчи")
    .row()
    .text("Заполнить анкету")
    .text("Смотреть анкеты")
    .row()
    .text("Пригласить")
    .text("Фото профиля")
    .row()
    .text("Помощь")
    .resized()
    .persistent();

export const HELP_TEXT =
  "Доступные действия:\n" +
  "• /start — регистрация и главное меню (deep link: /start REF_<код>)\n" +
  "• /profile — просмотр анкеты\n" +
  "• /profile_set — пошаговое заполнение анкеты\n" +
  "• /profile_delete — очистить анкету и фото в MinIO\n" +
  "• /cancel_profile — отменить заполнение анкеты\n" +
  "• /browse — просмотр кандидатов (лайк/пропуск)\n" +
  "• /likes — история отправленных лайков\n" +
  "• /matches — список мэтчей\n" +
  "• /invite — показать реферальный код\n" +
  "• /upload_photo — загрузить фото в MinIO/S3\n" +
  "• /cancel_photo — отменить ожидание фото\n" +
  "• /profile_help — подсказка по заполнению анкеты\n" +
  "• Кнопка «Помощь» — это сообщение\n\n";
