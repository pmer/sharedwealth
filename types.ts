export type Key = string;
export type Signature = string;

export interface Keypair {
  public: Key;
  private: Key;
}

export type Outputs = {
  amount: number;
  address: string;
}[];

export type Balances = Map<string,number>;
export type Nonces = Map<string,number>;

export interface Net {
  broadcast: (msg: string, o: string | object) => void;
  sendMessage: (address: string, msg: string, o: string | object) => void;
}
