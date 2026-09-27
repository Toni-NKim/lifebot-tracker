# **Habit & Routine Tracker — Product Requirements Prompt**

## **1\. Product Overview**

### **Working Title**

Habit & Routine Tracker

### **One-Sentence Description**

Mac mini에서 호스팅하고 Galaxy와 Mac에서 사용할 수 있는 개인용 반응형 Habit & Routine Tracker로, 모든 영구 데이터를 Obsidian에 기록하고 장기적으로 Hermes Lifebot의 생활 패턴 분석 데이터로 활용한다.

### **Product Goal**

매일 해야 할 Habit과 Routine을 최대한 간단하게 확인하고 기록할 수 있도록 한다.

단순 체크리스트에 그치지 않고 다음 데이터를 장기간 축적한다.

* Habit 및 Routine 수행 여부  
* 실제 완료 시점  
* 실제 소요시간  
* streak  
* 일·주·월·전체 완료율  
* 수행 정도  
* 난이도  
* 당시 에너지 수준

장기적으로 Todo, Health, Diet 데이터와 결합해 Hermes Lifebot이 개인의 생활 패턴과 목표 달성 과정을 분석할 수 있도록 한다.

---

# **2\. Target User**

이 앱은 단일 사용자를 위한 개인용 애플리케이션이다.

다중 사용자 서비스, 커뮤니티, 소셜 기능, 공개 서비스는 필요하지 않다.

주 사용 환경은 다음과 같다.

* Galaxy 스마트폰  
* Mac  
* Mac mini

Mac mini에서 애플리케이션을 호스팅하고 Galaxy와 Mac의 브라우저를 통해 접근한다.

Mac mini  
   ↓  
Habit Tracker Web App  
   ↓  
Galaxy / Mac Browser  
---

# **3\. Core Product Concepts**

Habit과 Routine은 서로 다른 객체로 취급한다.

## **Habit**

Habit은 독립적으로 수행할 수 있는 반복 행동이다.

예:

* 6시 기상  
* 세수하기  
* 비타민C \+ 티아미돌 바르기  
* 운동  
* 독서  
* 108배

## **Routine**

Routine은 여러 Habit을 하나의 상위 그룹으로 묶은 개념이다.

예:

아침 루틴  
├─ 6시 기상  
├─ 세수하기  
├─ 비타민C \+ 티아미돌 바르기  
└─ 데일리 브리핑 체크하기

Routine에 포함된 각 Habit은 개별적으로 완료 상태와 수행 기록을 가져야 한다.

Routine 자체의 완료 여부는 포함된 Habit들의 상태를 바탕으로 계산할 수 있어야 한다.

별도의 단계별 Routine 진행 화면은 필요하지 않다.

Today 화면에서 Habit을 바로 체크하는 방식이 기본 UX다.

---

# **4\. Primary User Journey**

## **Daily Flow**

1. 사용자가 Habit Tracker를 연다.  
2. 기본 화면은 `Today`다.  
3. 오늘 수행하도록 예정된 모든 Habit과 Routine을 확인한다.  
4. Routine이 있는 경우 Routine 이름을 상위 그룹으로 표시하고 그 아래 Habit을 표시한다.  
5. Habit을 수행하면 해당 Habit을 완료 처리한다.  
6. 완료 시각을 자동 기록한다.  
7. 필요한 경우 수행시간, 실제 수행량, 난이도/완성도, 에너지 상태 등을 기록한다.  
8. 완료 상태와 통계가 즉시 갱신된다.  
9. 날짜가 지나면 해당 날짜의 기록은 수정할 수 없다.

예:

Today

아침 루틴

☑ 6시 기상  
☑ 세수하기  
□ 비타민C \+ 티아미돌 바르기  
□ 데일리 브리핑 체크하기

운동

□ 헬스  
---

# **5\. Habit & Routine Management**

사용자는 다음 작업을 직접 할 수 있어야 한다.

### **Habit**

* 생성  
* 수정  
* 삭제  
* 활성화 / 비활성화

### **Routine**

* 생성  
* 수정  
* 삭제  
* Habit 추가  
* Habit 제거  
* Habit 순서 변경

Routine에 포함된 Habit도 독립적인 Habit 기록을 가진다.

---

# **6\. Scheduling System**

다음 반복 규칙을 모두 지원한다.

* 매일  
* 특정 요일  
* 평일  
* 주말  
* 주 N회  
* 월 N회  
* N일마다

각 Habit 또는 Routine에는 정확한 예정 시간을 지정할 수 있어야 한다.

예:

운동  
월·수·금  
19:00

또는:

독서  
주 5회  
22:00  
---

# **7\. Completion Rules**

## **Completion Status**

별도의 Skip 상태를 두지 않는다.

기본 상태는:

* Completed  
* Incomplete

뿐이다.

예정된 Habit을 수행하지 않으면 실패로 처리한다.

이는 streak와 완료율에 그대로 반영한다.

## **Historical Editing**

당일 기록은 수정할 수 있다.

날짜가 지나면 이전 날짜의 기록은 수정할 수 없다.

예를 들어 어제 운동을 실제로 했더라도 기록하지 않았다면 오늘 이를 완료 상태로 수정할 수 없다.

과거 기록을 소급 수정하지 못하도록 해 기록의 강제성을 유지한다.

---

# **8\. Minimum Duration & Actual Performance**

각 Habit에 `minimum duration`을 설정할 수 있어야 한다.

예:

독서  
Minimum duration: 20 minutes

MVP에서는 최소 수행시간을 기록하는 기능을 우선 지원한다.

모바일 환경에서는 향후 실제 타이머 기능을 추가한다.

---

# **9\. Quantitative / Partial Completion**

일부 Habit은 단순 Yes/No가 아니라 목표량을 가질 수 있다.

예:

108배  
Target: 108회

사용자가 해당 Habit을 수행했다고 판단하면 streak 자체는 성공으로 처리할 수 있다.

다만 실제 수행량은 별도 데이터로 저장한다.

예:

Target: 108  
Actual: 10  
Status: Completed

이를 통해 Lifebot은 단순 수행 여부뿐 아니라 수행 정도도 장기적으로 분석할 수 있어야 한다.

다음 필드를 지원한다.

* target\_amount  
* actual\_amount  
* unit

예:

Water  
Target: 5  
Actual: 3  
Unit: glass  
---

# **10\. Multiple Completions Per Day**

하루에 여러 번 수행하는 Habit을 지원하는 구조를 고려한다.

예:

물 200ml 마시기  
Target frequency: 5 times/day

각 회차별 완료를 기록하고 하루 목표 달성 여부를 계산할 수 있다.

단, 이 기능 때문에 MVP 구현 복잡도가 크게 증가할 경우 V2로 미룰 수 있다.

데이터 모델 자체는 향후 여러 회차 기록을 지원할 수 있도록 설계한다.

---

# **11\. Streak Logic**

## **Daily Habit**

매일 수행하는 Habit은 해당 날짜에 완료되면 streak가 1 증가한다.

하루라도 실패하면 streak가 종료된다.

## **Weekly Frequency Habit**

예:

운동  
3 times/week

해당 주에 목표 횟수를 채우면 weekly streak 1회를 성공한 것으로 처리한다.

다음 주에도 동일한 목표를 달성하면 streak가 이어진다.

## **Monthly Frequency Habit**

월 N회 Habit도 동일한 원칙을 사용한다.

해당 월 목표 횟수를 충족하면 해당 기간의 streak를 성공으로 처리한다.

---

# **12\. Completion Rate Logic**

모든 완료율은 동일한 원칙을 사용한다.

Completion Rate \=  
Completed Scheduled Occurrences  
÷  
Total Scheduled Occurrences  
× 100

이를 다음 기간에 적용한다.

* Daily  
* Weekly  
* Monthly  
* All-time

예:

이번 달 예정 횟수: 30  
완료 횟수: 24

Monthly completion rate \= 80%  
---

# **13\. Statistics Dashboard**

통계 화면은 다음 정보를 모두 제공한다.

### **Core Statistics**

* 현재 streak  
* 최장 streak  
* 일간 완료율  
* 주간 완료율  
* 월간 완료율  
* 전체 완료율

### **Visual Analytics**

* Calendar heatmap  
* 요일별 완료율  
* 시간대별 완료 패턴  
* Habit별 완료 추세

필요한 경우 Routine 단위 통계도 제공한다.

통계 UI는 복잡한 분석 도구처럼 보이기보다 일반 사용자가 바로 이해할 수 있는 형태로 구성한다.

---

# **14\. Today UI**

앱의 기본 진입 화면은 `Today`다.

오늘 수행할 Habit과 Routine을 한 화면에 모두 표시한다.

Routine에 포함된 Habit은 다음처럼 계층적으로 표현한다.

아침 루틴

☑ 6시 기상  
☑ 세수하기  
□ 비타민C \+ 티아미돌 바르기  
□ 데일리 브리핑 체크하기

독립 Habit은 별도 카드로 표시할 수 있다.

Today 화면에서 다음 정보를 최대한 쉽게 확인할 수 있어야 한다.

* Habit 이름  
* Routine 소속  
* 예정 시간  
* 완료 여부  
* 최소 수행시간  
* 필요시 목표량

UI에서 지나치게 많은 세부 정보를 항상 노출하지 않는다.

세부 정보는 Habit 상세 화면 또는 확장 UI를 통해 확인할 수 있다.

---

# **15\. Design Direction**

주요 디자인 참고 대상:

* Routinery  
* 마이루틴

특히 다음 디자인 패턴을 참고한다.

* Today 중심 화면  
* 카드형 Habit  
* Routine별 그룹화  
* 깔끔한 통계 화면  
* 모바일 친화적인 조작  
* 완료 여부를 즉시 파악할 수 있는 시각적 구조

과도한 게임화는 피한다.

Routine을 단계별로 강제 진행하는 별도 전체화면 UX도 필요하지 않다.

디자인은 깔끔하고 실용적이어야 하며 데스크톱과 모바일 모두 자연스럽게 사용할 수 있어야 한다.

---

# **16\. Responsive Web Application**

애플리케이션은 데스크톱과 모바일을 모두 지원하는 responsive web app으로 개발한다.

### **Desktop**

주요 기능:

* Today  
* Habit/Routine 관리  
* 최소 수행시간  
* 통계  
* 기록 조회

### **Mobile**

위 기능을 모두 지원하면서 향후 다음 기능을 추가한다.

* 일반 타이머  
* Pomodoro timer

모바일에서 타이머를 시작한 Habit은 해당 Habit과 연결돼야 한다.

향후 Todo Tracker의 타이머와 동일한 타이머 시스템을 공유할 수 있도록 설계한다.

---

# **17\. Notifications**

Habit Tracker 웹앱 자체에서는 알림 시스템을 구현하지 않는다.

알림은 Hermes Lifebot이 담당한다.

Lifebot은 Habit/Routine 상태를 확인하고 대략 3시간 간격으로 미완료 상태를 확인할 수 있다.

상황에 따라 사용자가 아직 수행하지 않은 Habit이나 Routine을 알려준다.

앱 자체의 push notification 시스템은 MVP 범위에서 제외한다.

---

# **18\. Contextual Logging**

Habit 완료 시 필요에 따라 추가 정보를 기록할 수 있어야 한다.

### **Duration**

실제 수행시간

### **Performance / Completeness**

목표 대비 실제 수행량

예:

108배  
Target: 108  
Actual: 10

### **Difficulty / Quality**

수행 난이도 또는 완성도에 대한 간단한 기록

### **Energy**

당시 에너지 상태를 자연어로 기록

예:

"오늘은 잠을 못 자서 매우 피곤했음."

이 정보는 향후 Lifebot 분석에 활용한다.

---

# **19\. Persistent Storage Architecture**

모든 영구 Habit 데이터는 Obsidian을 기준으로 관리한다.

다음 원칙을 반드시 지킨다.

> Obsidian Markdown files are the canonical source of truth for all persistent habit data. Maintain a local SQLite database only as a derived index for fast statistics, historical queries, and future Lifebot analysis. The SQLite database must be fully rebuildable from the canonical Obsidian data and must never become an independent or authoritative source of truth.

Architecture:

Habit Tracker  
      ↓  
Obsidian Markdown  
      ↓  
Indexer  
      ↓  
SQLite  
      ↓  
Statistics / Hermes Lifebot

### **Obsidian**

Obsidian Markdown이 authoritative storage다.

Habit 및 Routine 정의와 수행 기록을 모두 복구할 수 있을 정도의 정보를 Markdown에 저장한다.

### **SQLite**

SQLite는 다음 용도로만 사용한다.

* 빠른 통계 계산  
* 장기간 기록 조회  
* 기간별 집계  
* Lifebot 분석  
* 향후 다른 Life Tracker 데이터와의 JOIN

SQLite가 삭제돼도 Obsidian Vault만으로 완전히 다시 생성할 수 있어야 한다.

SQLite의 데이터가 Obsidian과 충돌할 경우 Obsidian 데이터를 기준으로 한다.

---

# **20\. Data Synchronization Direction**

기본 데이터 흐름은 단방향이다.

Habit Tracker  
      ↓  
Obsidian  
      ↓  
SQLite

Obsidian Markdown을 사람이 직접 수정했다고 해서 해당 변경 사항을 자동으로 웹앱에 역동기화할 필요는 없다.

앱에서 정상적으로 생성된 데이터가 Obsidian에 기록되는 것을 기본 흐름으로 한다.

---

# **21\. Suggested Data Model**

정확한 DB schema는 구현 과정에서 결정할 수 있지만 최소한 다음 개념을 지원한다.

## **Habit**

id  
name  
description  
parent\_routine\_id  
schedule\_type  
schedule\_config  
scheduled\_time  
minimum\_duration  
target\_amount  
target\_unit  
active  
created\_at  
updated\_at

## **Routine**

id  
name  
schedule  
scheduled\_time  
habit\_order  
active  
created\_at  
updated\_at

## **Habit Execution**

habit\_id  
date  
status  
completed\_at  
duration  
target\_amount  
actual\_amount  
unit  
difficulty\_or\_quality  
energy\_note

필요하면 multiple-completion Habit을 위해 execution event를 여러 개 기록할 수 있도록 확장 가능하게 설계한다.

---

# **22\. Account & Authentication**

이 애플리케이션은 개인용이므로 별도의 회원가입 시스템이나 다중 사용자 계정 시스템은 필요하지 않다.

외부 네트워크에서 Mac mini에 접속할 경우 필요한 최소한의 접근 보호 방식은 별도로 적용할 수 있다.

하지만 SaaS형 authentication system은 구현하지 않는다.

---

# **23\. Offline Support**

Galaxy가 Mac mini에 연결되지 않은 상태에서도 체크한 후 나중에 동기화하는 기능이 있으면 좋다.

다만 오프라인 동기화가 MVP 구현 난도를 크게 증가시키는 경우 V2 이후로 미룬다.

향후 추가 가능성을 막지 않는 구조로 설계한다.

---

# **24\. Hermes Lifebot Integration**

향후 Hermes Lifebot은 Habit Tracker 데이터를 읽고 쓸 수 있어야 한다.

### **Read Examples**

"오늘 루틴 완료율 알려줘."

"이번 달 운동 완료율은?"

"최근 3개월 동안 가장 자주 실패한 Habit은?"

"나는 어느 시간대에 Habit을 가장 잘 수행해?"

### **Write Examples**

"내일부터 아침 루틴에 비타민D 추가해줘."

"운동 Habit을 월·수·금으로 바꿔줘."

"독서 최소 시간을 30분으로 변경해줘."

Lifebot이 데이터를 변경할 경우에도 최종 기록은 반드시 Obsidian canonical data를 통해 이루어져야 한다.

SQLite를 직접 authoritative하게 수정해서는 안 된다.

---

# **25\. Future Cross-Tracker Integration**

장기적으로 다음 데이터 소스를 하나의 Lifebot 시스템으로 연결한다.

Habit / Routine Tracker  
          \+  
Todo Tracker  
          \+  
Health Data  
          \+  
FoodNoms  
          ↓  
      Obsidian  
          ↓  
       SQLite  
          ↓  
    Hermes Lifebot

Lifebot은 각 데이터를 독립적으로 보는 것이 아니라 서로의 관계를 분석할 수 있어야 한다.

예:

* 수면시간과 Habit 완료율 관계  
* 업무량과 운동 수행 여부 관계  
* 체중 변화와 운동 Habit 관계  
* 식사 패턴과 Habit 이행률 관계  
* 에너지 상태와 Habit 수행시간 관계

---

# **26\. Development Scope**

기능을 한 번에 모두 구현하지 않는다.

단계적으로 개발한다.

## **MVP**

반드시 구현:

* Habit CRUD  
* Routine CRUD  
* Habit/Routine 분리  
* Routine 내부 Habit 구조  
* 반복 일정  
* 정확한 예정 시간  
* Today UI  
* Habit 완료 기록  
* 완료 시각 기록  
* 최소 수행시간  
* 현재 streak  
* 최장 streak  
* 일/주/월/전체 완료율  
* 기본 통계 화면  
* Obsidian Markdown canonical storage  
* SQLite derived index  
* SQLite rebuild 기능  
* Responsive desktop/mobile UI

가능하면 포함:

* Calendar heatmap  
* 요일별 통계  
* 시간대별 통계  
* Habit별 추세

## **V2**

* 일반 타이머  
* Pomodoro timer  
* Mobile timer UX  
* 하루 여러 번 수행하는 Habit  
* actual amount / target amount 고도화  
* 고급 통계  
* Lifebot read integration  
* Lifebot write integration  
* Lifebot 미완료 알림  
* Offline capture \+ sync 가능성

## **V3**

* Todo Tracker 통합  
* Apple Health / InBody Health 데이터 통합  
* FoodNoms 식단 데이터 통합  
* 생산성·건강·식단·Habit 교차분석  
* 장기 패턴 분석  
* 개인 목표 기반 Lifebot coaching

---

# **27\. Non-Goals**

초기 버전에서 다음 기능은 목표가 아니다.

* 다중 사용자 지원  
* 소셜 기능  
* 커뮤니티  
* Habit 공유  
* 친구 경쟁  
* Marketplace  
* 복잡한 gamification  
* 자체 AI 코칭 엔진  
* 앱 자체 알림 시스템  
* 별도의 Routine 단계별 전체화면 진행 UX  
* SQLite를 primary database로 사용하는 구조

---

# **28\. Development Principles**

1. 기능을 한꺼번에 구현하지 말고 MVP부터 단계적으로 개발한다.  
2. 새로운 기능을 추가할 때 기존 기능을 불필요하게 변경하지 않는다.  
3. Obsidian source-of-truth 원칙을 절대 깨지 않는다.  
4. SQLite는 언제든 재생성 가능한 derived index로 유지한다.  
5. UI보다 데이터 무결성과 기록 구조를 우선한다.  
6. 데스크톱과 모바일 모두 실제 사용 가능한 상태를 유지한다.  
7. 향후 Todo, Health, Food 데이터를 결합할 수 있도록 시간, 날짜, ID 구조를 일관되게 설계한다.  
8. 각 단계가 정상 작동한 뒤 다음 기능으로 넘어간다.  
9. 구현 과정에서 Git을 사용해 안정적인 checkpoint를 만든다.  
10. 불필요한 외부 SaaS나 유료 서비스를 도입하지 않는다. 로컬 또는 무료 구현이 가능하면 이를 우선한다.

---

# **29\. Success Criteria**

MVP는 다음 조건을 모두 충족하면 성공한 것으로 본다.

1. Galaxy와 Mac에서 Today 화면을 정상적으로 사용할 수 있다.  
2. Habit과 Routine을 생성·수정·삭제할 수 있다.  
3. Routine 아래 여러 Habit을 구성할 수 있다.  
4. 모든 지원 반복 규칙에 맞춰 오늘의 Habit이 정확하게 생성된다.  
5. Habit을 완료하면 완료 시점이 기록된다.  
6. 전일 기록을 수정할 수 없다.  
7. streak가 정의된 규칙에 따라 정확하게 계산된다.  
8. 일/주/월/전체 완료율이 정확하게 계산된다.  
9. 통계 화면에서 장기 수행 패턴을 확인할 수 있다.  
10. 모든 영구 기록이 Obsidian Markdown에 존재한다.  
11. SQLite를 완전히 삭제한 뒤 Obsidian 데이터만으로 다시 구축할 수 있다.  
12. SQLite 재구축 후 통계 결과가 이전과 동일해야 한다.  
13. Habit Tracker 자체에 별도의 proprietary cloud database가 필요하지 않다.  
14. 향후 Hermes Lifebot이 데이터를 읽고 수정할 수 있는 명확한 인터페이스를 추가할 수 있다.

---

# **Final Instruction to the AI Coding Agent**

Start by reviewing this PRP and produce a scoped implementation plan before writing code.

Do not attempt to implement all future features at once.

Build the MVP incrementally.

Before implementation:

1. Propose the application architecture.  
2. Propose the Obsidian Markdown storage schema.  
3. Propose the derived SQLite schema.  
4. Explain how SQLite can be completely rebuilt from Obsidian.  
5. Propose the Habit/Routine scheduling model.  
6. Explain the streak and completion-rate algorithms.  
7. Propose the responsive Today UI and statistics UI.  
8. Divide implementation into small milestones.  
9. Identify any requirements that would materially increase complexity and recommend whether they belong in MVP or V2.  
10. Do not replace the specified Obsidian-first architecture with a conventional database-first architecture.

Wait until the architecture and milestone plan are internally consistent before implementing the application.

