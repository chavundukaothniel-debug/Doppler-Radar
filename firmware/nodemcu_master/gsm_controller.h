#pragma once
#include <stdint.h>
#include <stdio.h>
#include <string.h>

// Cooperative AT transaction engine. The sketch transports at most one TX byte
// per loop; waiting for the network never suspends radar or alarm processing.
class GsmController {
 public:
  enum class Step : uint8_t {
    Probe, Echo, Errors, Identity, Sim, Registration, Signal, ServiceCentre,
    Idle, TextMode, Charset, SmsParams, Prompt, Submit, Recover, Sync, Dial, CallStatus, Hangup, HangupFallback, CallCause
  };
  bool connected = false, registered = false, simReady = false, smscConfigured = false;
  int signal = 99;
  const char *sms = "NOT SENT";
  const char *call = "IDLE";
  char smsError[96]{}, callError[96]{}, statusError[96]{}, identity[64]{};
  char callDiagnostic[96]{}, cleanupError[96]{};
  uint32_t smsSentAt = 0, callPlacedAt = 0, smsSentCount = 0, callPlacedCount = 0;
  bool callsEnabled;

  GsmController(const char *recipient, bool calls) : callsEnabled(calls), phone(recipient) {}

  const char *stage() const {
    switch (step) {
      case Step::Probe: return "AT";
      case Step::Echo: return "ATE0";
      case Step::Errors: return "CMEE";
      case Step::Identity: return "ATI";
      case Step::Sim: return "CPIN";
      case Step::Registration: return "CREG";
      case Step::Signal: return "CSQ";
      case Step::ServiceCentre: return "CSCA";
      case Step::TextMode: return "CMGF";
      case Step::Charset: return "CSCS";
      case Step::SmsParams: return "CSMP";
      case Step::Prompt: return "CMGS prompt";
      case Step::Submit: return "CMGS result";
      case Step::Recover: return "Recovering";
      case Step::Sync: return "Resynchronizing";
      case Step::Dial: return "ATD";
      case Step::CallStatus: return "CLCC";
      case Step::Hangup: return "ATH";
      case Step::HangupFallback: return "CHUP";
      case Step::CallCause: return "CEER";
      default: return "Idle";
    }
  }

  void begin(uint32_t now) { command(Step::Probe, "AT", now); }
  void queueAlert(uint8_t sources, uint32_t now) { pendingSources |= sources; pendingAt = now; }
  bool hasTx() const { return txOffset < txLength; }
  uint8_t nextTx() const { return static_cast<uint8_t>(tx[txOffset]); }
  void txSent(uint32_t now) {
    if (++txOffset == txLength) { waiting = true; startedAt = now; }
  }
  void transportError(uint32_t now) { fail("Serial receive overflow", now); }

  void tick(uint32_t now) {
    if (hasTx()) return;
    if (callOpen && step != Step::Hangup && step != Step::HangupFallback && uint32_t(now - dialStartedAt) >= 20000) {
      command(Step::Hangup, "ATH", now);
      return;
    }
    if (step == Step::Recover) {
      if (uint32_t(now - startedAt) >= 2000) command(Step::Sync, "AT", now);
      return;
    }
    if (waiting) {
      if (uint32_t(now - startedAt) >= timeoutMs) fail("TIMEOUT", now);
      return;
    }
    if (step != Step::Idle) return;
    if (quietMs) {
      if (uint32_t(now - quietAt) < quietMs) return;
      quietMs = 0;
    }
    if (pendingCause) {
      pendingCause = false;
      command(Step::CallCause, "AT+CEER", now);
      return;
    }
    if (callOpen) {
      if (pollCalls && uint32_t(now - lastCallPollAt) >= 2000) {
        lastCallPollAt = now;
        sawCall = false;
        command(Step::CallStatus, "AT+CLCC", now);
      }
      return;
    }
    if (pendingSms) {
      pendingSms = false;
      if (connected && registered && simReady) {
        sms = "SENDING";
        smsError[0] = 0;
        command(Step::TextMode, "AT+CMGF=1", now, 5000);
      } else {
        copy(smsError, "GSM not ready after call");
        finishSms(now, false);
      }
      return;
    }
    if (pendingSources && uint32_t(now - pendingAt) > 60000) {
      pendingSources = 0;
      sms = "EXPIRED";
    }
    if (pendingSources && (!attempted || uint32_t(now - lastAttemptAt) >= 30000)) {
      if (!validPhone()) {
        sms = "DISABLED";
        copy(smsError, "Set ALERT_PHONE_NUMBER to digits, optionally +countrycode");
        pendingSources = 0;
      } else if (connected && registered && simReady) {
        attempted = true;
        lastAttemptAt = now;
        activeSources = pendingSources;
        pendingSources = 0;
        smsError[0] = callError[0] = callDiagnostic[0] = cleanupError[0] = 0;
        if (callsEnabled) {
          char cmd[48];
          snprintf(cmd, sizeof(cmd), "ATD%s;", phone);
          call = "DIALING";
          sms = "QUEUED";
          dialStartedAt = now;
          callOpen = pendingSms = true;
          callAnswered = false;
          command(Step::Dial, cmd, now, 10000);
        } else {
          sms = "SENDING";
          command(Step::TextMode, "AT+CMGF=1", now, 5000);
        }
        return;
      } else {
        sms = "WAITING FOR NETWORK";
      }
    }
    if (uint32_t(now - lastStatusAt) >= (registered ? 30000UL : 5000UL)) {
      lastStatusAt = now;
      command(Step::Probe, "AT", now);
    }
  }

  void feed(char ch, uint32_t now) {
    if (step == Step::Prompt && waiting && ch == '>') {
      char message[160];
      const char *source = activeSources == 1 ? "Radar 1: approaching target within 3 m" :
                           activeSources == 2 ? "Radar 2: movement detected" : "Radars 1 and 2: movement detected";
      snprintf(message, sizeof(message), "Doppler Radar alert. %s. Check the monitored area.%c", source, 26);
      sawSubmission = false;
      raw(Step::Submit, message, now, 65000);
      return;
    }
    if (ch == '\r') return;
    if (ch == '\n') {
      if (!lineOverflow && lineLength) {
        line[lineLength] = 0;
        processLine(now);
      }
      lineLength = 0;
      lineOverflow = false;
    } else if (lineLength < sizeof(line) - 1) {
      line[lineLength++] = ch;
    } else {
      lineOverflow = true;
    }
  }

 private:
  const char *phone;
  Step step = Step::Idle;
  bool waiting = false, initialized = false, attempted = false;
  bool sawSubmission = false, sawCall = false, pendingSms = false, callOpen = false;
  bool pendingCause = false, pollCalls = true, callAnswered = false;
  bool lineOverflow = false;
  char tx[192]{}, line[160]{};
  uint16_t txOffset = 0, txLength = 0, lineLength = 0;
  uint8_t pendingSources = 0, activeSources = 0;
  uint32_t startedAt = 0, timeoutMs = 3000, pendingAt = 0, lastAttemptAt = 0;
  uint32_t lastStatusAt = 0, dialStartedAt = 0, lastCallPollAt = 0;
  uint32_t quietAt = 0, quietMs = 0;

  template<size_t N> static void copy(char (&dest)[N], const char *value) {
    snprintf(dest, N, "%s", value);
  }
  bool validPhone() const {
    size_t n = strlen(phone);
    size_t firstDigit = phone[0] == '+' ? 1 : 0;
    if (n < firstDigit + 7 || n > firstDigit + 15) return false;
    for (size_t i = firstDigit; i < n; ++i) if (phone[i] < '0' || phone[i] > '9') return false;
    return true;
  }
  void raw(Step next, const char *data, uint32_t now, uint32_t timeout) {
    step = next;
    copy(tx, data);
    txLength = strlen(tx);
    txOffset = lineLength = 0;
    lineOverflow = false;
    waiting = false;
    startedAt = now;
    timeoutMs = timeout;
  }
  void command(Step next, const char *cmd, uint32_t now, uint32_t timeout = 3000) {
    raw(next, cmd, now, timeout);
    tx[txLength++] = '\r';
  }
  void idle(uint32_t now) { step = Step::Idle; waiting = false; lastStatusAt = now; }
  void finishSms(uint32_t now, bool success) {
    sms = success ? "SENT" : "FAILED";
    if (success) { smsSentAt = now; ++smsSentCount; }
    lastAttemptAt = now; // Cooldown begins after completion, including a long timeout.
    quietAt = now; quietMs = 2000;
    idle(now);
  }
  void fail(const char *reason, uint32_t now) {
    char detail[96];
    snprintf(detail, sizeof(detail), "%s: %.64s", stage(), reason);
    const Step failed = step;
    waiting = false;
    txOffset = txLength;
    if (failed == Step::TextMode || failed == Step::Charset || failed == Step::SmsParams || failed == Step::Prompt || failed == Step::Submit) {
      copy(smsError, detail);
      finishSms(now, false);
      // A missing prompt/result can leave the modem in text-entry mode.
      if ((failed == Step::Prompt || failed == Step::Submit) &&
          (strcmp(reason, "TIMEOUT") == 0 || strcmp(reason, "Serial receive overflow") == 0)) {
        raw(Step::Recover, "\x1b", now, 2000);
      }
    } else if (failed == Step::Dial) {
      copy(callError, detail);
      call = "FAILED";
      pendingCause = true;
      if (strcmp(reason, "TIMEOUT") == 0 || strcmp(reason, "Serial receive overflow") == 0) {
        command(Step::Hangup, "ATH", now);
      } else {
        endCall(now);
        pendingCause = true;
      }
    } else if (failed == Step::CallStatus) {
      // Some modem firmware does not support CLCC; retain the timed hang-up.
      copy(callDiagnostic, detail);
      pollCalls = false;
      if (!callOpen) endCall(now);
      else idle(now);
    } else if (failed == Step::Hangup) {
      copy(cleanupError, detail);
      command(Step::HangupFallback, "AT+CHUP", now);
    } else if (failed == Step::HangupFallback) {
      copy(cleanupError, detail);
      if (!callError[0]) copy(callError, "Call release unconfirmed");
      call = "FAILED";
      pendingSms = false;
      copy(smsError, "Skipped: call release unconfirmed");
      finishSms(now, false);
      endCall(now);
      pendingCause = true;
    } else if (failed == Step::CallCause) {
      if (!callDiagnostic[0]) copy(callDiagnostic, detail);
      idle(now);
    } else if (failed == Step::Echo) {
      command(Step::Errors, "AT+CMEE=2", now);
    } else if (failed == Step::Errors) {
      command(Step::Identity, "ATI", now);
    } else if (failed == Step::Identity) {
      simReady = false;
      command(Step::Sim, "AT+CPIN?", now);
    } else if (failed == Step::ServiceCentre) {
      copy(statusError, detail);
      initialized = true;
      idle(now);
    } else {
      copy(statusError, detail);
      if (failed == Step::Probe || failed == Step::Sync) {
        connected = registered = simReady = initialized = false;
      }
      if (failed == Step::Registration) registered = false;
      idle(now);
    }
  }
  void endCall(uint32_t now) {
    callOpen = false;
    quietAt = now; quietMs = 2000;
    idle(now);
  }
  void processLine(uint32_t now) {
    char *text = line;
    while (*text == ' ') ++text;
    if (!*text) return;
    // Unsolicited network/call changes are valid even when no query is pending.
    if (strncmp(text, "+CREG:", 6) == 0) {
      int first = -1, second = -1;
      int fields = sscanf(text + 6, " %d , %d", &first, &second);
      int status = fields == 2 ? second : first;
      registered = status == 1 || status == 5;
    }
    if (strcmp(text, "NO CARRIER") == 0 || strcmp(text, "BUSY") == 0 || strcmp(text, "NO ANSWER") == 0) {
      if (callOpen) {
        const bool expected = step == Step::Hangup || step == Step::HangupFallback || callAnswered;
        callOpen = false;
        if (strcmp(call, "FAILED") != 0) call = expected ? "ENDED" : "FAILED";
        if (!expected) { copy(callError, text); pendingCause = true; }
        // Consume the outstanding command's final response before sending another.
        if (!waiting || step == Step::Dial) endCall(now);
      }
      return;
    }
    if (!waiting) return;
    if (strcmp(text, "ERROR") == 0 || strncmp(text, "+CMS ERROR:", 11) == 0 || strncmp(text, "+CME ERROR:", 11) == 0) {
      fail(text, now);
      return;
    }
    if (step == Step::Sim && strncmp(text, "+CPIN:", 6) == 0) {
      simReady = strstr(text, "READY") != nullptr;
      if (!simReady) copy(statusError, text);
    }
    if (step == Step::Signal && strncmp(text, "+CSQ:", 5) == 0) sscanf(text + 5, " %d", &signal);
    if (step == Step::ServiceCentre && strncmp(text, "+CSCA:", 6) == 0) {
      const char *quote = strchr(text, '"');
      smscConfigured = quote && quote[1] && quote[1] != '"';
    }
    if (step == Step::Submit && strncmp(text, "+CMGS:", 6) == 0) sawSubmission = true;
    if (step == Step::CallCause && strncmp(text, "+CEER:", 6) == 0) copy(callDiagnostic, text);
    if (step == Step::CallStatus && strncmp(text, "+CLCC:", 6) == 0) {
      int id, direction, status;
      if (sscanf(text + 6, " %d , %d , %d", &id, &direction, &status) == 3 && direction == 0) {
        sawCall = true;
        if (status == 0) callAnswered = true;
        if (callOpen) call = status == 0 ? "ACTIVE" : status == 3 ? "RINGING" : "DIALING";
      }
    }
    if (step == Step::Identity && strcmp(text, "OK") != 0 && strncmp(text, "AT", 2) != 0) copy(identity, text);
    if (strcmp(text, "OK") != 0) return;
    switch (step) {
      case Step::Probe:
        connected = true;
        statusError[0] = 0;
        simReady = false;
        command(initialized ? Step::Sim : Step::Echo, initialized ? "AT+CPIN?" : "ATE0", now);
        break;
      case Step::Echo: command(Step::Errors, "AT+CMEE=2", now); break;
      case Step::Errors: command(Step::Identity, "ATI", now); break;
      case Step::Identity: command(Step::Sim, "AT+CPIN?", now); break;
      case Step::Sim:
        registered = false;
        command(Step::Registration, "AT+CREG?", now); break;
      case Step::Registration: command(Step::Signal, "AT+CSQ", now); break;
      case Step::Signal:
        if (!initialized) command(Step::ServiceCentre, "AT+CSCA?", now);
        else idle(now);
        break;
      case Step::ServiceCentre: initialized = true; idle(now); break;
      case Step::TextMode: command(Step::Charset, "AT+CSCS=\"GSM\"", now, 5000); break;
      case Step::Charset: command(Step::SmsParams, "AT+CSMP=17,167,0,0", now, 5000); break;
      case Step::SmsParams: {
        char cmd[48];
        snprintf(cmd, sizeof(cmd), "AT+CMGS=\"%s\"", phone);
        command(Step::Prompt, cmd, now, 10000);
        break;
      }
      case Step::Submit:
        if (sawSubmission) finishSms(now, true);
        else fail("OK received without +CMGS reference", now);
        break;
      case Step::Sync: connected = true; idle(now); break;
      case Step::Dial:
        if (!callOpen) { endCall(now); break; }
        ++callPlacedCount;
        callPlacedAt = now;
        lastCallPollAt = now;
        idle(now);
        break;
      case Step::CallStatus:
        if (!callOpen || (!sawCall && uint32_t(now - dialStartedAt) >= 5000)) {
          if (callOpen) {
            call = callAnswered ? "ENDED" : "FAILED";
            if (!callAnswered && !callError[0]) copy(callError, "Call ended before connection");
            pendingCause = !callAnswered;
          }
          endCall(now);
        } else idle(now);
        break;
      case Step::Hangup:
      case Step::HangupFallback:
        if (strcmp(call, "FAILED") != 0) call = "ENDED";
        endCall(now);
        break;
      case Step::CallCause: idle(now); break;
      default: break;
    }
  }
};
