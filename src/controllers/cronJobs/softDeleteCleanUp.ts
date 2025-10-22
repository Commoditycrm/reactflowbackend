import { Request, Response } from "express";
import { Neo4JConnection } from "../../database/connection";

const softDeleteCleanUp = async (req: Request, res: Response) => {
  const session = (await Neo4JConnection.getInstance()).driver.session();
  try {
    
  } catch (error) {
    res.status(500).json({ message: "Field to cleanup soft delete items." });
  }
};

export default softDeleteCleanUp;
