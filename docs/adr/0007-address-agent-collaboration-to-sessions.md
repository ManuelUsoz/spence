# 0007. Address Agent collaboration to Sessions

Status: accepted

An Agent coordinating work across Projects needs to reach the Session responsible for each part of the work. Address Agent Messages to writable Sessions, including Sessions with closed Tabs and Spence-owned Workers outside the sender's Worker tree. Provider-native Workers currently have read-only Sessions.

An Agent can start a regular Session with a first Message in another local Project. The destination Project supplies the defaults, and the new Session has an independent lifecycle. Worker parentage would couple its lifetime and execution settings to the source Session. Spence opens a background Tab in the destination Project in response to creation and preserves the user's focus. Messaging an existing Session preserves its Tab state.

Cross-Project contact and Session creation follow the sending Session's user-selected Permission mode. Auto permits both immediately. Ask uses a Permission request. The start request identifies the destination Project and shows the first Message. Approval to start a Session also lets the two Sessions exchange Messages. Other destinations and additional starts require their own permission decision. Each receiving Session runs under its own Permission mode.

A dedicated Effect `Coordinator` service in Electron main owns discovery, authorization, and routing for Agent collaboration. `Sessions` owns creation, Queues, and Turns. The Coordinator publishes a creation event so the app can open the background Tab. Any Session can initiate contact. Agents discover eligible Projects and writable Sessions by name, title, and status. Discovery omits archived Sessions. An otherwise authorized Message addressed to an archived Session by ID brings it back from the archive.

Each Thread records the Message with a link to the other Session and identifies its Project. Busy recipients receive Messages through their Queue, and the sender can see when a Message is queued. Accepted Messages and Session starts survive a restart. Retrying the same accepted request returns its original result without duplicating the Message, Session, or Tab.

Sending returns when Spence accepts the Message. With `await_result`, the sender can wait for the outcome and final reply of the exact Turn that Message started. A timeout returns `pending`. A one-time approval permits replies and progress updates within the exchange. Existing Always allow grants apply in their original direction. Spence limits automated back-and-forth.

If the Agent cannot start an accepted Session, its first Message and error remain visible in its Thread and the sender receives a failure result. A pending creation event can restore a background Tab after restart. Once the app has recorded the Tab, closing it takes precedence over replay.
